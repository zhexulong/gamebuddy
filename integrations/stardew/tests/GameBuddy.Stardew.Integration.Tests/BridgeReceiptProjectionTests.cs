using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Coverage of the stored-receipt to wire-receipt projection.
///
/// The projection names every wire field by hand, so a field added to the ledger
/// model stays unpublished until it is named there too. Two fields have already been
/// lost this way: the scene ground summary and the native notices. These cases pin
/// the carried fields directly against the projection, so an omission fails here
/// instead of silently dropping a fact the Agent was supposed to receive.
/// </summary>
public sealed class BridgeReceiptProjectionTests
{
    private const string ExecutionId = "exec_01";
    private const string RequestId = "req_01";
    private const string ActionId = "plant_seed";

    /// <summary>A structurally valid observation id: "so1_" plus 22 wire characters.</summary>
    private const string ObservationId = "so1_0123456789abcdefghijkl";

    [Fact]
    public void TryProjectReceipt_CarriesNativeNoticesToTheWire()
    {
        string[] notices = { "Out of season.", "Inventory Full" };
        LocalExecutionReceipt receipt = Receipt() with { NativeNotices = notices };

        BridgeSession.TryProjectReceipt(receipt, ActionId, Programme(), out BridgeReceipt bridge).Should().BeTrue();

        bridge.NativeNotices.Should().Equal(notices);
    }

    /// <summary>
    /// THE PROVENANCE IS A REQUIRED ARGUMENT, so this projection cannot publish a receipt without one - and the value it
    /// publishes is the one it was handed, never one it derived. That is the whole contract: the journal says which
    /// programme an execution belongs to, and this layer's only job is to carry it.
    /// </summary>
    [Fact]
    public void TryProjectReceipt_CarriesTheProvenanceTheJournalStated()
    {
        BridgeSession.TryProjectReceipt(Receipt(), ActionId, Programme(), out BridgeReceipt bridge).Should().BeTrue();

        bridge.Origin.Kind.Should().Be("programme");
        bridge.Origin.ProgramId.Should().Be("plan_01");
        bridge.Origin.NodeId.Should().Be("n01");
    }

    [Fact]
    public void TryProjectReceipt_RefusesAReceiptWithNoProvenanceAtAll()
    {
        // A null is not "no programme": `standalone` is. Refusing it here is what keeps the wire's union total, so a
        // reader downstream never has to decide what an absent origin meant.
        BridgeSession.TryProjectReceipt(Receipt(), ActionId, null!, out _).Should().BeFalse();
    }

    [Fact]
    public void TryProjectReceipt_LeavesNativeNoticesNullWhenThereWereNone()
    {
        // A dispatch that produced no notice must stay absent rather than become an
        // empty list: publishing an empty array would read as a claim that the game
        // said nothing, when the truth is only that nothing was captured.
        BridgeSession.TryProjectReceipt(Receipt(), ActionId, Programme(), out BridgeReceipt bridge).Should().BeTrue();

        bridge.NativeNotices.Should().BeNull();
    }

    [Fact]
    public void TryProjectReceipt_CarriesEveryOptionalFieldTheWireModels()
    {
        var observation = new BridgeLocalObservation("Farm", 1, 2, 0, "0600", false, 7);
        var scene = new ObserveSceneResultPayload(
            ObservationId,
            "Farm",
            "Farm",
            System.Array.Empty<ObserveSceneAffordancePayload>(),
            "Farm",
            false,
            null);
        LocalExecutionReceipt receipt = Receipt() with
        {
            Evidence = "target=seed;slot=0",
            Observation = observation,
            PiggybackedScene = scene,
            NativeNotices = new[] { "Out of season." },
        };

        BridgeSession.TryProjectReceipt(receipt, ActionId, Programme(), out BridgeReceipt bridge).Should().BeTrue();

        bridge.Evidence.Should().NotBeNull();
        bridge.Evidence!["detail"].Should().Be("target=seed;slot=0");
        bridge.Observation.Should().Be(observation);
        bridge.PiggybackedScene.Should().Be(scene);
        bridge.NativeNotices.Should().Equal("Out of season.");
    }

    [Fact]
    public void TryProjectReceipt_RefusesAnIdentityThatCannotGoOnTheWire()
    {
        // The wire identity charset is the contract; a receipt whose action lineage
        // cannot be represented must fail closed rather than publish a broken id.
        BridgeSession.TryProjectReceipt(Receipt(), "not a valid id!", Programme(), out _).Should().BeFalse();
    }

    private static BridgeExecutionOrigin Programme() => new("programme", "plan_01", "n01");

    private static LocalExecutionReceipt Receipt() =>
        new(ExecutionId, RequestId, ExecutionState.Succeeded, "seed_planted", 12, null, ActionId);
}
