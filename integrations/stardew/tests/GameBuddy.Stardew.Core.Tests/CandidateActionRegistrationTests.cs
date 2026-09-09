using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class CandidateActionRegistrationTests
{
    [Fact]
    public void ExpressEmote_RegistrationHasExactArgumentsAndDescriptor()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "express_emote");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("expression");
        reg.IdentityVersion.Should().Be(1);
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Expression);

        FarmhandActionDescriptor? desc = reg.Descriptor;
        desc.Should().NotBeNull();
        desc!.Arguments.Should().HaveCount(1);
        FarmhandActionArgument arg = desc.Arguments[0];
        arg.Name.Should().Be("emote");
        arg.Type.Should().Be("string");
        arg.Enum.Should().NotBeNull();
        arg.Enum.Should().Equal(FarmhandActionCatalog.EmoteEnum);
        arg.Enum.Should().HaveCount(22);
        arg.Enum.Should().Contain(new[] { "happy", "sad", "heart", "exclamation", "note", "sleep", "question" });

        desc.OutputFacts.Should().BeEmpty();
        desc.ResourceTemplate.Should().ContainSingle()
            .Which.Should().Be(new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer));
        desc.Effect.Should().Be("write");
        desc.Postcondition.Should().Be("emote_finished_or_overridden");
        desc.NativeBinding.Should().Be("Farmer.doEmote");
    }

    [Fact]
    public void FaceDirection_RegistrationHasExactArgumentsAndDescriptor()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "face_direction");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("movement_navigation");
        reg.IdentityVersion.Should().Be(1);
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Movement);

        FarmhandActionDescriptor? desc = reg.Descriptor;
        desc.Should().NotBeNull();
        desc!.Arguments.Should().HaveCount(1);
        FarmhandActionArgument arg = desc.Arguments[0];
        arg.Name.Should().Be("direction");
        arg.Type.Should().Be("string");
        arg.Enum.Should().NotBeNull();
        arg.Enum.Should().Equal("up", "right", "down", "left");

        desc.OutputFacts.Should().BeEmpty();
        desc.ResourceTemplate.Should().ContainSingle()
            .Which.Should().Be(new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer));
        desc.Effect.Should().Be("write");
        desc.Postcondition.Should().Be("actor_facing_matches");
        desc.NativeBinding.Should().Be("Farmer.faceDirection");
    }

    [Fact]
    public void CandidateActions_AreExcludedFromDefaultPolicySurface()
    {
        var defaultOptions = new ActionPolicyOptions();
        ActionPolicyEngine.ValidateActionPolicy(defaultOptions).Should().BeTrue();

        IReadOnlySet<string> enabled = ActionPolicyEngine.ComputeEnabledActions(defaultOptions);
        FarmhandCapabilitySet capabilities = FarmhandCapabilitySet.FromPolicyEnabledOperations(enabled);

        capabilities.AllowsExecutionAction("express_emote").Should().BeFalse();
        capabilities.AllowsExecutionAction("face_direction").Should().BeFalse();
    }

    [Fact]
    public void CandidateActions_AreIncludedWhenOptedIntoExperimentalActions()
    {
        var experimentalOptions = new ActionPolicyOptions(
            ExperimentalActions: new[] { "express_emote", "face_direction" }
        );
        ActionPolicyEngine.ValidateActionPolicy(experimentalOptions).Should().BeTrue();

        IReadOnlySet<string> enabled = ActionPolicyEngine.ComputeEnabledActions(experimentalOptions);
        FarmhandCapabilitySet capabilities = FarmhandCapabilitySet.FromPolicyEnabledOperations(enabled);

        capabilities.AllowsExecutionAction("express_emote").Should().BeTrue();
        capabilities.AllowsExecutionAction("face_direction").Should().BeTrue();
    }

    [Fact]
    public void ActionPolicyEngine_RejectsInvalidExperimentalActionId()
    {
        var invalidOptions = new ActionPolicyOptions(
            ExperimentalActions: new[] { "non_existent_action" }
        );
        ActionPolicyEngine.ValidateActionPolicy(invalidOptions).Should().BeFalse();
    }

    [Fact]
    public void BridgeProtocol_DeserializesValidExpressEmoteRequest()
    {
        string json = @"{
            ""protocolVersion"": 1,
            ""messageId"": ""msg_001"",
            ""correlationId"": ""corr_001"",
            ""timestampMs"": 1000,
            ""scope"": {
                ""integrationId"": ""stardew"",
                ""saveId"": ""save1"",
                ""worldId"": ""world1"",
                ""playerId"": ""player1"",
                ""companionId"": ""comp1""
            },
            ""type"": ""execution_request"",
            ""payload"": {
                ""requestId"": ""req_001"",
                ""idempotencyKey"": ""idem_001"",
                ""action"": ""express_emote"",
                ""args"": {
                    ""emote"": ""happy""
                },
                ""expectedRevision"": 1,
                ""deadlineMs"": 5000
            }
        }";

        BridgeProtocol.TryDeserializeExecutionRequest(json, out var envelope, out string reasonCode)
            .Should().BeTrue(reasonCode);
        envelope.Should().NotBeNull();
        envelope!.Payload.Action.Should().Be("express_emote");
        envelope.Payload.Args.Emote.Should().Be("happy");
    }

    [Fact]
    public void BridgeProtocol_RejectsInvalidEmoteEnum()
    {
        string json = @"{
            ""protocolVersion"": 1,
            ""messageId"": ""msg_002"",
            ""correlationId"": ""corr_002"",
            ""timestampMs"": 1000,
            ""scope"": {
                ""integrationId"": ""stardew"",
                ""saveId"": ""save1"",
                ""worldId"": ""world1"",
                ""playerId"": ""player1"",
                ""companionId"": ""comp1""
            },
            ""type"": ""execution_request"",
            ""payload"": {
                ""requestId"": ""req_002"",
                ""idempotencyKey"": ""idem_002"",
                ""action"": ""express_emote"",
                ""args"": {
                    ""emote"": ""not_an_emote""
                },
                ""expectedRevision"": 1,
                ""deadlineMs"": 5000
            }
        }";

        BridgeProtocol.TryDeserializeExecutionRequest(json, out _, out string reasonCode)
            .Should().BeFalse();
        reasonCode.Should().Be("invalid_envelope");
    }

    [Fact]
    public void BridgeProtocol_DeserializesValidFaceDirectionRequest()
    {
        string json = @"{
            ""protocolVersion"": 1,
            ""messageId"": ""msg_003"",
            ""correlationId"": ""corr_003"",
            ""timestampMs"": 1000,
            ""scope"": {
                ""integrationId"": ""stardew"",
                ""saveId"": ""save1"",
                ""worldId"": ""world1"",
                ""playerId"": ""player1"",
                ""companionId"": ""comp1""
            },
            ""type"": ""execution_request"",
            ""payload"": {
                ""requestId"": ""req_003"",
                ""idempotencyKey"": ""idem_003"",
                ""action"": ""face_direction"",
                ""args"": {
                    ""direction"": ""up""
                },
                ""expectedRevision"": 1,
                ""deadlineMs"": 5000
            }
        }";

        BridgeProtocol.TryDeserializeExecutionRequest(json, out var envelope, out string reasonCode)
            .Should().BeTrue(reasonCode);
        envelope.Should().NotBeNull();
        envelope!.Payload.Action.Should().Be("face_direction");
        envelope.Payload.Args.Direction.Should().Be("up");
    }

    [Fact]
    public void BridgeProtocol_RejectsInvalidDirectionEnum()
    {
        string json = @"{
            ""protocolVersion"": 1,
            ""messageId"": ""msg_004"",
            ""correlationId"": ""corr_004"",
            ""timestampMs"": 1000,
            ""scope"": {
                ""integrationId"": ""stardew"",
                ""saveId"": ""save1"",
                ""worldId"": ""world1"",
                ""playerId"": ""player1"",
                ""companionId"": ""comp1""
            },
            ""type"": ""execution_request"",
            ""payload"": {
                ""requestId"": ""req_004"",
                ""idempotencyKey"": ""idem_004"",
                ""action"": ""face_direction"",
                ""args"": {
                    ""direction"": ""diagonal_up""
                },
                ""expectedRevision"": 1,
                ""deadlineMs"": 5000
            }
        }";

        BridgeProtocol.TryDeserializeExecutionRequest(json, out _, out string reasonCode)
            .Should().BeFalse();
        reasonCode.Should().Be("invalid_envelope");
    }

    [Fact]
    public void BridgeReceipt_WithLocalObservation_SerializesAndDeserializes()
    {
        var observation = new BridgeLocalObservation(
            "Farm",
            64,
            12,
            2,
            "0600",
            true,
            1
        );

        var receipt = new BridgeReceipt(
            "exec_001",
            "req_001",
            "express_emote",
            "succeeded",
            "emote_finished_or_overridden",
            1,
            new Dictionary<string, string> { ["test"] = "evidence" },
            observation
        );

        var envelope = new BridgeEnvelope<BridgeReceipt>(
            BridgeProtocol.Version,
            "msg_receipt_01",
            "corr_receipt_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            "execution_receipt",
            receipt
        );

        BridgeProtocol.TrySerialize(envelope, out string json, out string reasonCode)
            .Should().BeTrue(reasonCode);
        json.Should().Contain("\"observation\":{");
        json.Should().Contain("\"facing\":2");
        json.Should().Contain("\"playerNearby\":true");

        BridgeProtocol.TryDeserializeExecutionReceipt(json, out var deserialized, out string deserializationReason)
            .Should().BeTrue(deserializationReason);
        deserialized.Should().NotBeNull();
        deserialized!.Payload.Observation.Should().NotBeNull();
        deserialized.Payload.Observation!.Location.Should().Be("Farm");
        deserialized.Payload.Observation.TileX.Should().Be(64);
        deserialized.Payload.Observation.TileY.Should().Be(12);
        deserialized.Payload.Observation.Facing.Should().Be(2);
        deserialized.Payload.Observation.InGameTime.Should().Be("0600");
        deserialized.Payload.Observation.PlayerNearby.Should().BeTrue();
    }

    [Fact]
    public void BridgeWorldFact_SerializesAndDeserializes()
    {
        var fact = new BridgeWorldFact(
            "day_started_day_1",
            "day_started_day_1",
            "day_started",
            120,
            "0600",
            1,
            "day_started_day_1"
        );

        var envelope = new BridgeEnvelope<BridgeWorldFact>(
            BridgeProtocol.Version,
            "msg_fact_01",
            "corr_fact_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            "world_fact",
            fact
        );

        BridgeProtocol.TrySerialize(envelope, out string json, out string reasonCode)
            .Should().BeTrue(reasonCode);
        json.Should().Contain("\"kind\":\"day_started\"");
        json.Should().Contain("\"observedTick\":120");

        BridgeProtocol.TryDeserializeWorldFact(json, out var deserialized, out string deserializationReason)
            .Should().BeTrue(deserializationReason);
        deserialized.Should().NotBeNull();
        deserialized!.Payload.EventId.Should().Be("day_started_day_1");
        deserialized.Payload.ObservedTick.Should().Be(120);
        deserialized.Payload.Kind.Should().Be("day_started");
    }
}
