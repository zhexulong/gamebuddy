using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The `farmhand_action_policy_request` payload: the ONE live action-policy path.
///
/// <para>
/// A RUNNING world learns that the player changed their action policy from this frame, not from a periodic
/// reread of `config.json`. The frame therefore carries the same two denial keys the document carries, and
/// this file pins the three facts that makes true: the payload is exactly those two keys and nothing else, the
/// policy it carries is the one the Mod's own catalogue judges, and a pushed policy can only remove actions
/// the catalogue already publishes.
/// </para>
///
/// <para>
/// The wire spells the keys camelCase because the bridge's one codec does that to every frame
/// (<see cref="BridgeProtocol.JsonOptions"/>); it is the same two keys `config.json` carries, rendered the way
/// this transport renders all of them.
/// </para>
/// </summary>
public sealed class FarmhandActionPolicyFrameTests
{
    private const string TypeName = "farmhand_action_policy_request";
    private const string EnvelopePrefix =
        "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,"
        + "\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\","
        + "\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},"
        + "\"type\":\"farmhand_action_policy_request\",\"payload\":";

    private static readonly BridgeScope SampleScope = new("stardew", "save_1", "world_1", "player_1", "companion_1");

    /// <summary>The exact payload keys the Mod reads: the two `ModConfig` denial keys, on the wire.</summary>
    private static readonly string[] PayloadKeys = { "deniedActions", "deniedActionFamilies" };

    private static BridgeEnvelope<FarmhandActionPolicy> Envelope(FarmhandActionPolicy policy) =>
        new(BridgeProtocol.Version, "msg_1", "corr_1", 1000, SampleScope, TypeName, policy);

    private static bool TryRead(string json, out BridgeEnvelope<FarmhandActionPolicy>? envelope, out string reasonCode) =>
        BridgeProtocol.TryDeserializeInbound(json, TypeName, out envelope, out reasonCode, PayloadKeys);

    [Fact]
    public void TheFrameCarriesTheTwoDenialKeysTheConfigDocumentCarries()
    {
        FarmhandActionPolicy policy = new()
        {
            DeniedActions = { "water_crop" },
            DeniedActionFamilies = { "crops" },
        };

        BridgeProtocol.TrySerialize(Envelope(policy), out string json, out string serializeReason).Should().BeTrue(serializeReason);
        json.Should().Contain("\"deniedActions\":[\"water_crop\"]")
            .And.Contain("\"deniedActionFamilies\":[\"crops\"]");
        json.Should().NotContain("enabledActionSet")
            .And.NotContain("experimentalActions")
            .And.NotContain("bridgeToken");

        TryRead(json, out BridgeEnvelope<FarmhandActionPolicy>? envelope, out string reasonCode).Should().BeTrue(reasonCode);
        envelope!.Payload.DeniedActions.Should().Equal("water_crop");
        envelope.Payload.DeniedActionFamilies.Should().Equal("crops");
    }

    [Fact]
    public void APayloadCarryingAnyThirdKeyIsRefusedWhole()
    {
        // The frame is not a second config document. A key the file owns - the bridge credentials, the fixture
        // fields, the test-only ExperimentalActions opt-in - would make two authorities for one config, so the
        // exact-key check refuses the frame instead of silently ignoring the extra key.
        TryRead(EnvelopePrefix + "{\"deniedActions\":[],\"deniedActionFamilies\":[],\"experimentalActions\":[\"x\"]}}",
            out BridgeEnvelope<FarmhandActionPolicy>? refused, out string reasonCode).Should().BeFalse();
        refused.Should().BeNull();
        reasonCode.Should().Be("invalid_envelope");

        TryRead(EnvelopePrefix + "{\"deniedActions\":[]}}", out BridgeEnvelope<FarmhandActionPolicy>? partial, out reasonCode)
            .Should().BeFalse("both denial keys are required, because an absent list is not an empty one");
        partial.Should().BeNull();
    }

    [Fact]
    public void APushedPolicyCanOnlyNarrowThePublishedSet()
    {
        var catalog = FarmhandActionCatalog.Registrations;
        catalog.Should().NotBeEmpty();

        IReadOnlySet<string> baseline = ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions());
        baseline.Should().NotBeEmpty("deny-by-exception means the catalogue's own default consent set is published");

        string deniedAction = baseline.First();
        IReadOnlySet<string> withoutOneAction = ActionPolicyEngine.ComputeEnabledActions(
            new ActionPolicyOptions(DeniedActions: new[] { deniedAction }));
        withoutOneAction.Should().NotContain(deniedAction);
        withoutOneAction.Count.Should().Be(baseline.Count - 1);
        withoutOneAction.Should().BeSubsetOf(baseline);

        string deniedFamily = catalog.First(registration => registration.ActionId == deniedAction).FamilyId;
        IReadOnlySet<string> withoutAFamily = ActionPolicyEngine.ComputeEnabledActions(
            new ActionPolicyOptions(DeniedActionFamilies: new[] { deniedFamily }));
        withoutAFamily.Should().BeSubsetOf(baseline);
        withoutAFamily.Count.Should().Be(baseline.Count
            - catalog.Count(registration => registration.FamilyId == deniedFamily
                && ActionPolicyEngine.IsDefaultConsentLifecycle(registration.Lifecycle)));
    }

    [Fact]
    public void APolicyNamingSomethingTheCatalogueDoesNotDeclareIsRefused()
    {
        ActionPolicyEngine.ValidateActionPolicy(new ActionPolicyOptions()).Should().BeTrue();
        ActionPolicyEngine.ValidateActionPolicy(new ActionPolicyOptions(DeniedActions: new[] { "no_such_action" }))
            .Should().BeFalse("a pushed policy is judged by the Mod's own catalogue, not accepted because the Host sent it");
        ActionPolicyEngine.ValidateActionPolicy(new ActionPolicyOptions(DeniedActionFamilies: new[] { "no_such_family" }))
            .Should().BeFalse();
    }
}
