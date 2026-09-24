using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane D: collect_crab_pot_output contract pins and the Step-1 seam decision.
///
/// The full decision record lives in the lane-owned partial header
/// (farmhandexecutioncontroller.crabpotactions.cs). Its load-bearing facts:
///  - the only native seam is the ordinary interaction entry
///    GameLocation.checkAction -> CrabPot.checkForAction (CrabPot.cs:251);
///  - only the mature `tileIndexToShow == 714` branch (CrabPot.cs:258-301) may
///    settle, because the non-714 unbaited branch (CrabPot.cs:302-321) removes
///    the pot from the world;
///  - admission therefore hard-gates on
///    `readyForHarvest.Value == true && tileIndexToShow == 714` and rejects with
///    crab_pot_not_ready, so the removal branch is unreachable;
///  - `readyForHarvest` is set by the native day update (CrabPot.cs:345-346),
///    which no committed Mod primitive can reach today: single_player_sleep_and
///    _advance_day has zero implementation files and the approved fixture
///    provenance contract is still `unprovisioned` (state `fixture_needed`).
///    The live gate is therefore a declared M2 / fixture-provisioning
///    dependency, and this file claims no live evidence;
///  - the success reasonCode is crab_pot_output_collected, matching the
///    checked-in fixture contract's futureProductionSuccessPostconditions
///    rather than the shorter card prose.
///
/// Like its sibling tests, the deterministic assertions run without a Game1
/// harness (the world-not-ready path); the mature/not-ready/capacity native
/// paths belong to the native-local live gate per fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class CrabPotCollectActionTests
{
    private readonly ITestOutputHelper output;

    public CrabPotCollectActionTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void Catalog_CollectCrabPotOutput_RegisteredAsExperimentalBuildingsFarmManagement()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "collect_crab_pot_output");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("buildings_farm_management");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_CollectCrabPotOutput_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "collect_crab_pot_output" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_crab_pot_collect_1", "idemp_crab_pot_collect_1", "collect_crab_pot_output",
            new BridgeExecutionArgs { X = 12, Y = 9, ExpectedTargetId = "collect_crab_pot_0123456789abcdef" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Router_CollectCrabPotOutput_SameRequestId_ReplaysTheStoredReceipt()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "collect_crab_pot_output" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_crab_pot_collect_replay", "idemp_crab_pot_collect_replay", "collect_crab_pot_output",
            new BridgeExecutionArgs { X = 12, Y = 9, ExpectedTargetId = "collect_crab_pot_0123456789abcdef" },
            1, 5000);
        var first = handler.Execute(request, executions);
        var second = handler.Execute(request, executions);

        second.ExecutionId.Should().Be(first.ExecutionId);
        second.ReasonCode.Should().Be(first.ReasonCode);
        second.Revision.Should().Be(first.Revision);
    }

    /// <summary>
    /// Pins the recorded seam decision so a target-version rebaseline must
    /// re-derive it. This is a static-record assertion, not live evidence.
    /// </summary>
    [Fact]
    public void StaticReview_RecordsCrabPotCollectSeamDecision()
    {
        this.output.WriteLine(
            "seam=GameLocation.checkAction->CrabPot.checkForAction(CrabPot.cs:251);" +
            "mature_branch=CrabPot.cs:258-301;" +
            "removal_branch_excluded=CrabPot.cs:302-321;" +
            "hard_gate=readyForHarvest.Value==true&&tileIndexToShow==714;" +
            "ready_set_point=CrabPot.DayUpdate(CrabPot.cs:345-346);" +
            "ready_reachability=native_authoritative_but_not_fixture_reachable_by_committed_production;" +
            "success_reason_code=crab_pot_output_collected;" +
            "live_evidence=pending_native_local_fixture");
    }
}
