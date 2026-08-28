using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Task 3 multi-hop Navigation lifecycle: one request/execution receipt lineage
/// across multiple ordinary warp legs, proven without a target runtime.
/// The fake approach/commit seam only synthesizes arm results, controller
/// transitions and the warp commit; it can never bypass navigation admission,
/// active ownership, pre-commit revalidation, phase transition, Warped
/// correlation, terminal settlement, or the fresh replan on each leg.
/// </summary>
public sealed class NavigationExecutionManagerTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");
    private static readonly NavigationTransitionLeg MineLeg = new("Mine", 10, 10, 20, 20, IsDoor: false);
    private const string SourceFarm = "Farm";

    // ── existing direct-leg tests (superseded only where the multi-hop lifecycle
    //    deliberately changes the expected post-warp behavior) ──

    [Fact]
    public void ValidOrdinaryWarpAdmission_YieldsOneAcceptedLineage_NoPrimitiveReceipt()
    {
        var harness = new ManagerHarness(NotAtFarm());

        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_admit", Label("Mine"), Deadline());
        receipt.State.Should().Be(ExecutionState.Accepted);
        receipt.ReasonCode.Should().Be("accepted");
        receipt.RequestId.Should().Be("req_admit");

        harness.Manager.IsBodySettled.Should().BeFalse();
        harness.Manager.TryGetReceipt("req_admit", out LocalExecutionReceipt? stored).Should().BeTrue();
        stored!.Should().Be(receipt);
        stored.State.Should().Be(ExecutionState.Accepted);
        // The approach was armed through the fake seam, but no primitive LocalMove/
        // Travel receipt was generated: the ledger holds exactly this one lineage.
        harness.Armed.Should().NotBeEmpty();
        // Navigation receipt state remains public, but route/progress traces may
        // carry live location/tile and are intentionally never published.
        harness.Manager.Trace.Should().BeEmpty();
    }

    [Fact]
    public void SafeAdjacentApproachTarget_IsSelected_NotTransitionSourceTile()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.RequestNavigate("req_app", new NavigationDestinationSelector("label", "Mine", null), Deadline());

        LocalMoveSpec spec = harness.Armed.Single();
        // Never path onto the warp source tile (10,10); stand on a cardinal-adjacent tile.
        spec.TargetTile.Should().NotBe(new Vector2(10, 10));
        (Math.Abs((int)spec.TargetTile.X - 10) + Math.Abs((int)spec.TargetTile.Y - 10)).Should().Be(1);
    }

    [Fact]
    public void ApproachFailure_WithControllerTerminal_SettlesNavigationExactlyOnce()
    {
        var harness = new ManagerHarness(NotAtFarm());
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req3", Label("Mine"), Deadline());

        harness.Emit(ExecutionState.Failed, "native_path_ended", "route_broken");

        LocalExecutionReceipt terminal = harness.Stored("req3");
        terminal.State.Should().Be(ExecutionState.Failed);
        terminal.ReasonCode.Should().Be("native_path_ended");
        terminal.ExecutionId.Should().Be(accepted.ExecutionId);
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    [Fact]
    public void ApproachCancellation_BeforeCommit_SettlesCancelledExactlyOnce()
    {
        var harness = new ManagerHarness(NotAtFarm());
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req4", Label("Mine"), Deadline());

        LocalExecutionReceipt cancelled = harness.Manager.Cancel("req4", accepted.ExecutionId, "player_redirect");
        cancelled.State.Should().Be(ExecutionState.Cancelled);
        harness.Manager.IsBodySettled.Should().BeTrue();
        LocalExecutionReceipt late = harness.Manager.Cancel("req4", accepted.ExecutionId, "player_redirect");
        late.State.Should().Be(ExecutionState.Cancelled);
        harness.Stored("req4").ExecutionId.Should().Be(accepted.ExecutionId);
    }

    [Fact]
    public void ApproachInvalidated_ByLifecycle_SettlesExactlyOnce()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.RequestNavigate("req5", Label("Mine"), Deadline());

        harness.Manager.InvalidateForLifecycle("menu_opened");

        LocalExecutionReceipt terminal = harness.Stored("req5");
        terminal.State.Should().Be(ExecutionState.Invalidated);
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    [Fact]
    public void ApproachDeadline_WithElapsedTime_SettlesExpiredExactlyOnce()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.RequestNavigate("req_dead", Label("Mine"), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1);
        Thread.Sleep(40);

        harness.Manager.Update();

        var terminal = harness.Stored("req_dead");
        terminal.State.Should().Be(ExecutionState.Expired);
        terminal.ReasonCode.Should().Be("navigation_deadline_expired");
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    [Fact]
    public void NullRuntime_FailsClosedWithoutActiveExecution()
    {
        var harness = new ManagerHarness(NotAtFarm(), withRuntime: false);
        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_noruntime", Label("Mine"), Deadline());
        receipt.State.Should().Be(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().Be("destination_access_indeterminate");
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    [Fact]
    public void DoorLeg_FailsClosedAndNeverArmsNativeCommit()
    {
        var doorLeg = new NavigationTransitionLeg("Mine", 5, 5, 6, 6, IsDoor: true);
        var harness = new ManagerHarness(View(true, true, "Farm", at: false, new[] { doorLeg }));

        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_invalid_deadline1", Label("Mine"), Deadline());

        receipt.State.Should().Be(ExecutionState.Blocked);
        receipt.ReasonCode.Should().Be("destination_access_indeterminate");
        harness.Armed.Should().BeEmpty();
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    [Fact]
    public void NativeCommitException_SettlesOnceUncertain_AndNeverRetries()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.CommitToThrow = true;
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_commit", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        // The commit is deferred to the next Update; the throw settles once.
        harness.Manager.Update();

        var terminal = harness.Stored("req_commit");
        terminal.State.Should().Be(ExecutionState.Uncertain);
        terminal.ReasonCode.Should().Be("navigation_commit_exception");
        terminal.ExecutionId.Should().Be(accepted.ExecutionId);
        harness.Manager.IsBodySettled.Should().BeTrue();
        harness.CompleteWarp(SourceFarm, "Mine", 20, 20);
        harness.Stored("req_commit").State.Should().Be(ExecutionState.Uncertain);
    }

    [Fact]
    public void MismatchedWarpEvent_SettlesOnceUncertain()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.RequestNavigate("req_warp", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        harness.CompleteWarp(SourceFarm, "Elsewhere", 99, 99);

        var receipt = harness.Stored("req_warp");
        receipt.State.Should().Be(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().Be("navigation_warp_postcondition_mismatch");
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    [Fact]
    public void WrongOldSource_WithMatchingTarget_SettlesOnceUncertain_AndNeverRetries()
    {
        var harness = new ManagerHarness(NotAtFarm());
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_src", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        // Matching new destination target, but the warp came from the wrong old source.
        harness.CompleteWarp("Elsewhere", "Mine", 20, 20);

        var receipt = harness.Stored("req_src");
        receipt.State.Should().Be(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().Be("navigation_warp_source_mismatch");
        receipt.ExecutionId.Should().Be(accepted.ExecutionId);
        harness.Manager.IsBodySettled.Should().BeTrue();
        // A superseding navigate reuses no second lineage: duplicate replay returns the terminal.
        LocalExecutionReceipt replay = harness.Manager.RequestNavigate("req_src", Label("Mine"), Deadline());
        replay.Should().Be(receipt);
    }

    [Fact]
    public void Terminal_SettlesOnce_NoActiveOwnership_AndLateCallbacksInert()
    {
        var harness = new ManagerHarness(NotAtFarm());
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_term", Label("Mine"), Deadline());
        harness.Emit(ExecutionState.Failed, "native_path_ended", "route_broken");

        var terminal = harness.Stored("req_term");
        terminal.State.Should().Be(ExecutionState.Failed);
        terminal.ExecutionId.Should().Be(accepted.ExecutionId);
        harness.Manager.IsBodySettled.Should().BeTrue();

        // No active ownership remains for a fixture-wide cancel.
        LocalExecutionReceipt idle = harness.Manager.CancelActiveForFixture("fixture_teardown");
        idle.State.Should().Be(ExecutionState.Cancelled);
        idle.ReasonCode.Should().Be("no_active_execution");

        // A late success callback cannot overwrite the terminal.
        harness.Emit(ExecutionState.Succeeded, "target_reached", "tile=9,10;target=10,10");
        harness.CompleteWarp(SourceFarm, "Mine", 20, 20);
        harness.Stored("req_term").State.Should().Be(ExecutionState.Failed);

        // Exactly one execution lineage is present; Navigation never publishes
        // body traces (including terminal/idle), which could expose route state.
        harness.Manager.Trace.Should().BeEmpty();
        LocalExecutionReceipt replay = harness.Manager.RequestNavigate("req_term", Label("Mine"), Deadline());
        replay.Should().Be(harness.Stored("req_term"));
    }

    [Fact]
    public void NoSafeApproachCandidate_RejectsExactlyOnce_BeforeArmOrCommit()
    {
        // A location with zero safe cardinal-adjacent standing tiles must fail
        // closed before controller arm, ownership, commit, or primitive receipt.
        var harness = new ManagerHarness(NotAtFarm(), withRuntime: true, evaluateCandidate: _ => false);

        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_nosafe", Label("Mine"), Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("navigation_approach_unavailable");
        harness.Armed.Should().BeEmpty();
        harness.Commits.Should().Be(0);
        harness.Manager.IsBodySettled.Should().BeTrue();
        harness.Manager.TryGetReceipt("req_nosafe", out LocalExecutionReceipt? stored).Should().BeTrue();
        stored!.State.Should().Be(ExecutionState.Rejected);
        stored.ExecutionId.Should().Be(receipt.ExecutionId);
        // No accepted lineage, no execution_started trace, no active ownership.
        harness.Manager.Trace.Any(t => t.Category == "execution_started").Should().BeFalse();
        harness.Manager.CancelActiveForFixture("teardown").ReasonCode.Should().Be("no_active_execution");
    }

    [Fact]
    public void SafeApproach_ImpassableOccupiedCandidateSkipped_SafeAlternateChosen()
    {
        // First cardinal candidate (9,10) blocked/occupied; the fix must skip it
        // and choose the next deterministic safe neighbor (11,10).
        var harness = new ManagerHarness(NotAtFarm(), withRuntime: true, evaluateCandidate: tile => !(tile.X == 9f && tile.Y == 10f));

        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_alternate", Label("Mine"), Deadline());

        receipt.State.Should().Be(ExecutionState.Accepted);
        LocalMoveSpec spec = harness.Armed.Single();
        spec.TargetTile.Should().Be(new Vector2(11, 10));
        harness.Manager.IsBodySettled.Should().BeFalse();
    }

    [Fact]
    public void AcceptedAndRunningReceiptEvidence_ContainsNoRoutePrimitiveFacts()
    {
        var harness = new ManagerHarness(NotAtFarm());

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_ev", Label("Mine"), Deadline());
        accepted.Evidence.Should().Be("navigation=accepted;phase=approaching");
        accepted.Evidence!.Should().NotContain("leg=").And.NotContain("approach=").And.NotContain("destination=").And.NotContain("source=");

        // The approach body reports a private target coordinate; the bounded running
        // receipt must NOT propagate that route primitive to the bridge.
        harness.Emit(ExecutionState.Running, "controller_started", "target=10,10");
        LocalExecutionReceipt running = harness.Stored("req_ev");
        running.State.Should().Be(ExecutionState.Running);
        running.Evidence.Should().Be("navigation=running;phase=approaching");
        running.Evidence!.Should().NotContain("10,10").And.NotContain("target=").And.NotContain("tile=");
        harness.Manager.Trace.Should().BeEmpty();
    }

    [Fact]
    public void NavigationLineage_NeverPublishesPositionBearingBodyTrace()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.RequestNavigate("req_no_trace", Label("Mine"), Deadline());
        harness.Emit(ExecutionState.MeaningfulProgress, "controller_progress", "target=10,10");
        harness.Emit(ExecutionState.Failed, "native_path_ended", "route_broken");

        harness.Manager.Trace.Should().BeEmpty();
    }

    [Fact]
    public void ProductionConstruction_UsesRealApproachNative()
    {
        var production = new ExecutionManager(new DummyMonitor(), Surface());
        production.UsesRealApproachNative.Should().BeTrue();
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.UsesRealApproachNative.Should().BeFalse();
    }

    // ── multi-hop tests ──

    [Fact]
    public void TwoHopFarmToMountainToMine_CommitsTwiceAndSettlesSingleNavigationCompleted()
    {
        NavigationTransitionLeg farmToMountain = new("Mountain", 1, 1, 2, 2, IsDoor: false);
        NavigationTransitionLeg mountainToMine = new("Mine", 3, 3, 4, 4, IsDoor: false);
        var harness = new MultiHopHarness(
            initial: View(true, true, "Farm", at: false, new[] { farmToMountain }),
            secondView: View(true, true, "Mountain", at: false, new[] { mountainToMine }),
            arrivalView: View(true, true, "Mine", at: true, Array.Empty<NavigationTransitionLeg>()),
            topologySources: new Dictionary<string, IReadOnlyList<NavigationTransitionLeg>>(StringComparer.Ordinal)
            {
                ["Farm"] = new[] { farmToMountain },
                ["Mountain"] = new[] { mountainToMine },
                ["Mine"] = Array.Empty<NavigationTransitionLeg>(),
            });

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_2hop", Label("Mine"), Deadline());
        accepted.State.Should().Be(ExecutionState.Accepted);

        // First leg: approach → commit → warp
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.Commits.Should().Be(1);
        // Warp event for first leg (Farm → Mountain)
        harness.CompleteWarp("Farm", "Mountain", 2, 2);
        // Second leg should be armed automatically
        harness.Armed.Should().HaveCount(2);
        harness.Manager.IsBodySettled.Should().BeFalse();

        // Second leg: approach → commit → warp
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.Commits.Should().Be(2);
        // Warp event for second leg (Mountain → Mine)
        harness.CompleteWarp("Mountain", "Mine", 4, 4);

        // Single navigation_completed terminal
        var receipt = harness.Stored("req_2hop");
        receipt.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("navigation_completed");
        receipt.ExecutionId.Should().Be(accepted.ExecutionId);
        harness.Manager.IsBodySettled.Should().BeTrue();
        harness.Manager.Trace.Should().BeEmpty();
    }

    [Fact]
    public void ProductionWarpSettlementKeepsNextLegArmed()
    {
        NavigationTransitionLeg farmToMountain = new("Mountain", 1, 1, 2, 2, IsDoor: false);
        NavigationTransitionLeg mountainToMine = new("Mine", 3, 3, 4, 4, IsDoor: false);
        var harness = new MultiHopHarness(
            initial: View(true, true, "Farm", at: false, new[] { farmToMountain }),
            secondView: View(true, true, "Mountain", at: false, new[] { mountainToMine }),
            arrivalView: View(true, true, "Mine", at: true, Array.Empty<NavigationTransitionLeg>()),
            topologySources: new Dictionary<string, IReadOnlyList<NavigationTransitionLeg>>(StringComparer.Ordinal)
            {
                ["Farm"] = new[] { farmToMountain },
                ["Mountain"] = new[] { mountainToMine },
                ["Mine"] = Array.Empty<NavigationTransitionLeg>(),
            });

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_warp_lifecycle", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        NavigationWarpLifecycle.Settle(harness.Manager, true, "Farm", "Mountain", 2, 2);

        LocalExecutionReceipt receipt = harness.Stored("req_warp_lifecycle");
        receipt.ExecutionId.Should().Be(accepted.ExecutionId);
        receipt.State.Should().Be(ExecutionState.Running);
        receipt.ReasonCode.Should().Be("navigation_multi_hop_leg_armed");
        harness.Armed.Should().HaveCount(2);
        harness.Manager.IsBodySettled.Should().BeFalse();
    }

    [Fact]
    public void ProductionWarpSettlementUsesActualOldLocationForCorrelation()
    {
        var harness = new ManagerHarness(NotAtFarm());
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_wrong_source", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        NavigationWarpLifecycle.Settle(harness.Manager, true, "Town", "Mine", 20, 20);

        LocalExecutionReceipt receipt = harness.Stored("req_wrong_source");
        receipt.ExecutionId.Should().Be(accepted.ExecutionId);
        receipt.State.Should().Be(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().Be("navigation_warp_source_mismatch");
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    [Fact]
    public void TwoHop_StaleEdgeAfterFirstWarp_IsDiscardedByFreshPlan()
    {
        // After the first warp, connectivity returns a different set of edges
        // that does not include the stale Farm→Mountain edge.
        NavigationTransitionLeg farmToMountain = new("Mountain", 1, 1, 2, 2, IsDoor: false);
        NavigationTransitionLeg mountainToMine = new("Mine", 3, 3, 4, 4, IsDoor: false);
        var harness = new MultiHopHarness(
            initial: View(true, true, "Farm", at: false, new[] { farmToMountain }),
            secondView: View(true, true, "Mountain", at: false, new[] { mountainToMine }),
            arrivalView: View(true, true, "Mine", at: true, Array.Empty<NavigationTransitionLeg>()),
            topologySources: new Dictionary<string, IReadOnlyList<NavigationTransitionLeg>>(StringComparer.Ordinal)
            {
                ["Farm"] = new[] { farmToMountain },
                ["Mountain"] = new[] { mountainToMine },
                ["Mine"] = Array.Empty<NavigationTransitionLeg>(),
            });

        harness.Manager.RequestNavigate("req_stale", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        // Warp to Mountain
        harness.CompleteWarp("Farm", "Mountain", 2, 2);

        // The second leg arms from the Mountain view, not from the stale Farm topology.
        harness.Armed.Should().HaveCount(2);
        LocalMoveSpec secondLeg = harness.Armed[1];
        // Approach target should be adjacent to the Mountain→Mine warp source (3,3)
        secondLeg.TargetTile.Should().NotBe(new Vector2(3, 3));
        (Math.Abs((int)secondLeg.TargetTile.X - 3) + Math.Abs((int)secondLeg.TargetTile.Y - 3)).Should().Be(1);
    }

    [Fact]
    public void AcceptedRefContinuesAfterReferenceStoreCleared()
    {
        // Uses PlanFresh which never re-resolves the selector, so ref expiry
        // after admission cannot revoke the accepted execution.
        var references = new NavigationReferenceStore();
        var set = new DerivedDestinationSet("generation_01",
            new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()),
            new[] { new NavigationDestination("stardew", "Mine", "Mine", null) });
        var context = new NavigationBindingContext("runtime_01", Scope, set.Generation, 1, DateTimeOffset.UtcNow);
        string reference = references.IssueDestination(context,
            new NavigationDestinationBinding("stardew", "Mine", set.Generation, 1));

        NavigationTransitionLeg leg = new("Mine", 10, 10, 20, 20, IsDoor: false);
        var harness = new ManagerHarness(
            View(true, true, "Farm", at: false, new[] { leg }),
            withRuntime: true, evaluateCandidate: null,
            customRefStore: references, customSet: set);

        // Admit via ref, then clear the store.
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_ref", new NavigationDestinationSelector("ref", null, reference), Deadline());
        accepted.State.Should().Be(ExecutionState.Accepted);
        references.ClearForSourceGenerationChange();

        // The execution continues because the coordinator copied the binding at admission.
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.CompleteWarp("Farm", "Mine", 20, 20);
        var receipt = harness.Stored("req_ref");
        receipt.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("navigation_completed");
    }

    [Fact]
    public void DuplicateLateWarp_SettlesOnceUncertain_DoesNotRetry()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.RequestNavigate("req_dup", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        // First warp matches
        harness.CompleteWarp(SourceFarm, "Mine", 20, 20);
        var receipt = harness.Stored("req_dup");
        receipt.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("navigation_completed");

        // Duplicate late warp is inert (no active navigation)
        harness.CompleteWarp(SourceFarm, "Mine", 20, 20);
        harness.Stored("req_dup").State.Should().Be(ExecutionState.Succeeded);
    }

    [Fact]
    public void PostCommitCancellation_SettlesUncertainAndNeverRetries()
    {
        var harness = new ManagerHarness(NotAtFarm());
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_post", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        LocalExecutionReceipt cancelled = harness.Manager.Cancel("req_post", accepted.ExecutionId, "player_redirect");
        cancelled.State.Should().Be(ExecutionState.Uncertain);
        harness.Manager.IsBodySettled.Should().BeTrue();
        LocalExecutionReceipt late = harness.Manager.Cancel("req_post", accepted.ExecutionId, "player_redirect");
        late.State.Should().Be(ExecutionState.Uncertain);
    }

    [Fact]
    public void PostCommitLifecycleInvalidation_SettlesUncertainAndNeverRetries()
    {
        var harness = new ManagerHarness(NotAtFarm());
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_life", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        harness.Manager.InvalidateForLifecycle("lifecycle_boundary");

        var terminal = harness.Stored("req_life");
        terminal.State.Should().Be(ExecutionState.Uncertain);
        terminal.ReasonCode.Should().Be("navigation_invalidated_after_warp_child");
        terminal.ExecutionId.Should().Be(accepted.ExecutionId);
        harness.Manager.IsBodySettled.Should().BeTrue();
        LocalExecutionReceipt late = harness.Manager.Cancel("req_life", accepted.ExecutionId, "player_redirect");
        late.State.Should().Be(ExecutionState.Uncertain);
    }

    [Fact]
    public void UnreadablePostWarpTopology_SettlesOnceUncertain()
    {
        // After the first warp, connectivity returns null (unreadable).
        NavigationTransitionLeg farmToMountain = new("Mountain", 1, 1, 2, 2, IsDoor: false);
        var harness = new MultiHopHarness(
            initial: View(true, true, "Farm", at: false, new[] { farmToMountain }),
            secondView: View(true, true, "Mountain", at: false, Array.Empty<NavigationTransitionLeg>()),
            arrivalView: null,
            topologySources: new Dictionary<string, IReadOnlyList<NavigationTransitionLeg>>(StringComparer.Ordinal)
            {
                ["Farm"] = new[] { farmToMountain },
                ["Mountain"] = Array.Empty<NavigationTransitionLeg>(),
                ["Mine"] = Array.Empty<NavigationTransitionLeg>(),
            },
            failConnectivityAfterFirstWarp: true);

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_unread", Label("Mountain"), Deadline());
        accepted.State.Should().Be(ExecutionState.Accepted);
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        // First warp succeeds
        harness.CompleteWarp("Farm", "Mountain", 2, 2);

        // Post-warp coordinator gets null topology → terminal uncertain
        var receipt = harness.Stored("req_unread");
        receipt.State.Should().Be(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().Be("destination_access_indeterminate");
        harness.Manager.IsBodySettled.Should().BeTrue();
        // Only one commit (the first leg)
        harness.Commits.Should().Be(1);
        // Only one arm (the first leg)
        harness.Armed.Should().HaveCount(1);
    }

    [Fact]
    public void MultiHop_NoPublicBodyTrace()
    {
        NavigationTransitionLeg farmToMountain = new("Mountain", 1, 1, 2, 2, IsDoor: false);
        NavigationTransitionLeg mountainToMine = new("Mine", 3, 3, 4, 4, IsDoor: false);
        var harness = new MultiHopHarness(
            initial: View(true, true, "Farm", at: false, new[] { farmToMountain }),
            secondView: View(true, true, "Mountain", at: false, new[] { mountainToMine }),
            arrivalView: View(true, true, "Mine", at: true, Array.Empty<NavigationTransitionLeg>()),
            topologySources: new Dictionary<string, IReadOnlyList<NavigationTransitionLeg>>(StringComparer.Ordinal)
            {
                ["Farm"] = new[] { farmToMountain },
                ["Mountain"] = new[] { mountainToMine },
                ["Mine"] = Array.Empty<NavigationTransitionLeg>(),
            });

        harness.Manager.RequestNavigate("req_mt_trace", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.CompleteWarp("Farm", "Mountain", 2, 2);
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.CompleteWarp("Mountain", "Mine", 4, 4);

        harness.Manager.Trace.Should().BeEmpty();
    }

    [Fact]
    public void TwoHop_MultiHopArmFailure_DoesNotRetry()
    {
        NavigationTransitionLeg farmToMountain = new("Mountain", 1, 1, 2, 2, IsDoor: false);
        NavigationTransitionLeg mountainToMine = new("Mine", 3, 3, 4, 4, IsDoor: false);
        var harness = new MultiHopHarness(
            initial: View(true, true, "Farm", at: false, new[] { farmToMountain }),
            secondView: View(true, true, "Mountain", at: false, new[] { mountainToMine }),
            arrivalView: null,
            topologySources: new Dictionary<string, IReadOnlyList<NavigationTransitionLeg>>(StringComparer.Ordinal)
            {
                ["Farm"] = new[] { farmToMountain },
                ["Mountain"] = new[] { mountainToMine },
                ["Mine"] = Array.Empty<NavigationTransitionLeg>(),
            },
            failArmAfterFirstWarp: true);

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_armfail", Label("Mine"), Deadline());
        accepted.State.Should().Be(ExecutionState.Accepted);
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        // First warp succeeds
        harness.CompleteWarp("Farm", "Mountain", 2, 2);

        // Second leg arm failed → terminal uncertain, not retried.
        var receipt = harness.Stored("req_armfail");
        receipt.State.Should().Be(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().Be("navigation_multi_hop_arm_failed");
        harness.Manager.IsBodySettled.Should().BeTrue();
        harness.Armed.Should().HaveCount(1);
        harness.Commits.Should().Be(1);
    }

    // ── helpers ──

    private static Func<FarmhandCapabilityPublication> Surface()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(new[] { "navigate_to_destination" }));
        return () => publication;
    }

    private static long Deadline() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000;

    private static NavigationDestinationSelector Label(string label) => new("label", label, null);

    private static NavigationWorldView NotAtFarm() => View(true, true, "Farm", at: false, new[] { MineLeg });

    private static NavigationWorldView View(bool live, bool actionable, string source, bool at, IReadOnlyList<NavigationTransitionLeg> legs)
        => new(live, actionable, source, 0, 0, at, legs, BoundaryExcludesDestination: false, DestinationTemporarilyUnavailable: false, TransitionAmbiguousOrUnknown: false, UncorrelatedTransition: false);

    /// <summary>Mutable fake world source so the fresh coordinator re-read can change.</summary>
    private sealed class MutableWorldSource : INavigationWorldSource
    {
        private readonly NavigationWorldView normal;
        private NavigationWorldView? destination;
        internal MutableWorldSource(NavigationWorldView normal) => this.normal = normal;
        internal void MoveToDestination() => this.destination = View(true, true, "Mine", at: true, Array.Empty<NavigationTransitionLeg>());
        internal void ObserveLocation(string location, bool atDestination) =>
            this.destination = View(true, true, location, atDestination, Array.Empty<NavigationTransitionLeg>());
        public NavigationWorldView CurrentView(NavigationDestinationBinding binding) => this.destination ?? this.normal;
    }

    /// <summary>Connectivity source that derives a topology from the MutableWorldSource's current view.</summary>
    private sealed class MutableConnectivitySource : INavigationConnectivitySource
    {
        private readonly MutableWorldSource world;
        private readonly string currentSourceId;
        internal MutableConnectivitySource(MutableWorldSource world, string currentSourceId)
        {
            this.world = world;
            this.currentSourceId = currentSourceId;
        }

        public bool TryCreateCurrentOrdinaryWarpTopology(
            NavigationDestinationBinding acceptedBinding,
            out NavigationOrdinaryWarpTopology? topology,
            out string reasonCode)
        {
            NavigationWorldView view = this.world.CurrentView(acceptedBinding);
            string? source = view.CurrentSourceLocation ?? this.currentSourceId;
            var sources = new Dictionary<string, List<NavigationTransitionLeg>>(StringComparer.Ordinal);
            sources[source] = new List<NavigationTransitionLeg>(view.OrdinaryLegs);
            sources[acceptedBinding.CanonicalDestinationIdentity] = new List<NavigationTransitionLeg>();
            foreach (NavigationTransitionLeg leg in view.OrdinaryLegs)
            {
                if (!sources.ContainsKey(leg.TargetLocation))
                    sources[leg.TargetLocation] = new List<NavigationTransitionLeg>();
            }
            topology = new NavigationOrdinaryWarpTopology(
                source,
                sources.Select(kvp => new NavigationOrdinaryWarpLegs(kvp.Key, kvp.Value)).ToArray());
            reasonCode = "accepted";
            return true;
        }
    }

    private sealed class ManagerHarness
    {
        internal ExecutionManager Manager { get; }
        internal MutableWorldSource Source { get; }
        internal List<LocalMoveSpec> Armed { get; } = new();
        internal bool CommitToThrow { get; set; }
        internal int Commits { get; private set; }

        internal ManagerHarness(
            NavigationWorldView initial,
            bool withRuntime = true,
            Func<Vector2, bool>? evaluateCandidate = null,
            NavigationReferenceStore? customRefStore = null,
            DerivedDestinationSet? customSet = null)
        {
            this.Manager = new ExecutionManager(new DummyMonitor(), Surface());
            this.Source = new MutableWorldSource(initial);
            var references = customRefStore ?? new NavigationReferenceStore();
            var destinations = new[] { new NavigationDestination("stardew", "Mine", "Mine", null) };
            var set = customSet ?? new DerivedDestinationSet("generation_01", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()), destinations);
            if (withRuntime)
            {
                var connectivity = new MutableConnectivitySource(this.Source, initial.CurrentSourceLocation ?? "Farm");
                this.Manager.SetNavigationRuntimeFactory(() => new NavigationRuntimeSnapshot(references, "runtime_01", Scope, () => set, this.Source, connectivity));
            }
            this.Manager.SetNavigationApproachNative(new NavigationApproachNative(
                (spec, farmer, tick) => { this.Armed.Add(spec); return (true, "accepted"); },
                (farmer, leg) => new StardewValley.Warp(leg.SourceX, leg.SourceY, leg.TargetLocation, leg.TargetX, leg.TargetY, flipFarmer: false, npcOnly: false),
                (farmer, warp) => { if (this.CommitToThrow) throw new InvalidOperationException("native warp threw"); this.Commits++; },
                evaluateCandidate ?? (_ => true)));
            this.Manager.SetNavigationLifecycleTestAuthorization(() => true);
        }

        internal void Emit(ExecutionState state, string reasonCode, string? evidence) => this.Manager.EmitNavigationApproachTransition(state, reasonCode, evidence);
        internal void EmitApproachSucceeded() => this.Emit(ExecutionState.Succeeded, "target_reached", "tile=9,10;target=10,10");
        internal void CompleteWarp(string oldLocation, string newLocation, int newTileX, int newTileY)
        {
            this.Source.ObserveLocation(newLocation, string.Equals(newLocation, "Mine", StringComparison.Ordinal));
            this.Manager.CompleteNavigationAfterWarp(true, oldLocation, newLocation, newTileX, newTileY);
        }
        internal LocalExecutionReceipt Stored(string requestId)
        {
            this.Manager.TryGetReceipt(requestId, out LocalExecutionReceipt? receipt).Should().BeTrue();
            return receipt!;
        }
    }

    /// <summary>Harness that sequences multiple world views and connectivity for multi-hop tests.</summary>
    private sealed class MultiHopHarness
    {
        internal ExecutionManager Manager { get; }
        internal List<LocalMoveSpec> Armed { get; } = new();
        internal int Commits { get; private set; }
        private readonly bool failArmAfterFirstWarp;

        internal MultiHopHarness(
            NavigationWorldView initial,
            NavigationWorldView secondView,
            NavigationWorldView? arrivalView,
            Dictionary<string, IReadOnlyList<NavigationTransitionLeg>> topologySources,
            bool failConnectivityAfterFirstWarp = false,
            bool failArmAfterFirstWarp = false)
        {
            this.failArmAfterFirstWarp = failArmAfterFirstWarp;
            this.Manager = new ExecutionManager(new DummyMonitor(), Surface());
            var references = new NavigationReferenceStore();
            var destinations = new[]
            {
                new NavigationDestination("stardew", "Mine", "Mine", null),
                new NavigationDestination("stardew", "Mountain", "Mountain", null),
            };
            var set = new DerivedDestinationSet("generation_01", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()), destinations);

            // Each native leg is planned once at admission/continuation and
            // revalidated once immediately before commit. The view changes only
            // after the correlated warp callback.
            var worldViews = new List<NavigationWorldView> { initial, initial, secondView, secondView };
            if (arrivalView is not null)
                worldViews.Add(arrivalView);
            var worldSource = new SequenceWorldSource(worldViews);

            // Connectivity follows the source most recently observed by the
            // fresh world read and can become unreadable only after the first warp.
            var connectivity = new SequenceConnectivitySource(worldSource, topologySources, failConnectivityAfterFirstWarp);

            this.Manager.SetNavigationRuntimeFactory(() => new NavigationRuntimeSnapshot(references, "runtime_01", Scope, () => set, worldSource, connectivity));
            this.Manager.SetNavigationApproachNative(new NavigationApproachNative(
                (spec, farmer, tick) =>
                {
                    if (this.Armed.Count >= 1 && this.failArmAfterFirstWarp)
                        return (false, "approach_arm_failed");
                    this.Armed.Add(spec);
                    return (true, "accepted");
                },
                (farmer, leg) => new StardewValley.Warp(leg.SourceX, leg.SourceY, leg.TargetLocation, leg.TargetX, leg.TargetY, flipFarmer: false, npcOnly: false),
                (farmer, warp) => { this.Commits++; },
                _ => true));
            this.Manager.SetNavigationLifecycleTestAuthorization(() => true);
        }

        internal void EmitApproachSucceeded() => this.Manager.EmitNavigationApproachTransition(ExecutionState.Succeeded, "target_reached", "tile=9,10;target=10,10");
        internal void CompleteWarp(string oldLocation, string newLocation, int newTileX, int newTileY) =>
            this.Manager.CompleteNavigationAfterWarp(true, oldLocation, newLocation, newTileX, newTileY);
        internal LocalExecutionReceipt Stored(string requestId)
        {
            this.Manager.TryGetReceipt(requestId, out LocalExecutionReceipt? receipt).Should().BeTrue();
            return receipt!;
        }
    }

    private sealed class SequenceWorldSource : INavigationWorldSource
    {
        private readonly Queue<NavigationWorldView> views;
        internal SequenceWorldSource(List<NavigationWorldView> views) => this.views = new Queue<NavigationWorldView>(views);
        internal string? CurrentSourceLocation { get; private set; }
        public NavigationWorldView CurrentView(NavigationDestinationBinding binding)
        {
            NavigationWorldView view = this.views.Dequeue();
            this.CurrentSourceLocation = view.CurrentSourceLocation;
            return view;
        }
    }

    private sealed class SequenceConnectivitySource : INavigationConnectivitySource
    {
        private readonly SequenceWorldSource world;
        private readonly Dictionary<string, IReadOnlyList<NavigationTransitionLeg>> sources;
        private readonly bool failAfterFirstWarp;
        private int callCount;

        internal SequenceConnectivitySource(
            SequenceWorldSource world,
            Dictionary<string, IReadOnlyList<NavigationTransitionLeg>> sources,
            bool failAfterFirstWarp = false)
        {
            this.world = world;
            this.sources = sources;
            this.failAfterFirstWarp = failAfterFirstWarp;
        }

        public bool TryCreateCurrentOrdinaryWarpTopology(
            NavigationDestinationBinding acceptedBinding,
            out NavigationOrdinaryWarpTopology? topology,
            out string reasonCode)
        {
            this.callCount++;
            if (this.failAfterFirstWarp && this.callCount > 2)
            {
                topology = null;
                reasonCode = "connectivity_unavailable";
                return false;
            }

            var sourceList = this.sources
                .Select(kvp => new NavigationOrdinaryWarpLegs(kvp.Key, kvp.Value))
                .ToArray();
            string current = this.world.CurrentSourceLocation ?? this.sources.Keys.First();
            topology = new NavigationOrdinaryWarpTopology(current, sourceList);
            reasonCode = "accepted";
            return true;
        }
    }
}