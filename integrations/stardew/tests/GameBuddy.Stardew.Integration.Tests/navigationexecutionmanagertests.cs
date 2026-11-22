using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
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
        // The body-trace channel that used to carry route/progress per tile is gone: the executor publishes the answer
        // and nothing about the body on the way to it, so there is no field here that could expose a live location.
        // What remains observable is the lineage's receipt, and arming the approach does not change it.
        harness.Stored("req_admit").State.Should().Be(ExecutionState.Accepted);
    }

    [Fact]
    public void PreboundNavigationExecutionId_IsUsedForAcceptedAndTerminalReceipts()
    {
        var harness = new ManagerHarness(NotAtFarm());
        IDispatchExecutionLedger ledger = harness.Manager;

        ledger.TryBindDispatch("req_bound", "navigate_to_destination", "execution_bound", out string bindReason)
            .Should().BeTrue();
        bindReason.Should().Be("bound");

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_bound", Label("Mine"), Deadline());
        accepted.ExecutionId.Should().Be("execution_bound");

        harness.Emit(ExecutionState.Failed, "native_path_ended", "route_broken");
        harness.Stored("req_bound").ExecutionId.Should().Be("execution_bound");
    }

    [Fact]
    public void RebindingNavigationExecutionIdentityFailsAndKeepsOriginalBinding()
    {
        var harness = new ManagerHarness(NotAtFarm());
        IDispatchExecutionLedger ledger = harness.Manager;

        ledger.TryBindDispatch("req_rebind", "navigate_to_destination", "execution_original", out _)
            .Should().BeTrue();
        ledger.TryBindDispatch("req_rebind", "navigate_to_destination", "execution_other", out string reason)
            .Should().BeFalse();
        reason.Should().Be("execution_identity_conflict");

        harness.Manager.RequestNavigate("req_rebind", Label("Mine"), Deadline()).ExecutionId.Should().Be("execution_original");
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

    /// <summary>
    /// A REFUSED SELECTOR NAMES THE FACT THAT REFUSED IT. Measured `round85` (`plan_323`): the receipt read
    /// `destination_selector_stale` with `detail=destination` - the word the admission published whenever a ref
    /// resolution carried no label - for a `dr1_` handle copied out of an observation six minutes earlier, so neither
    /// the cause, the handle's age, nor the next step was in the artifact, and the same handle was planned again.
    /// </summary>
    [Fact]
    public void StaleDestinationRef_NamesItsCauseItsAgeAndItsNextStep()
    {
        var references = new NavigationReferenceStore();
        // Issued six minutes before the request: past the store's own five-minute lifetime, which is what `plan_323` did.
        var issuedAt = new NavigationBindingContext("runtime_01", Scope, "generation_01", 1, DateTimeOffset.UtcNow.AddMinutes(-6));
        string staleRef = references.IssueDestination(issuedAt, new NavigationDestinationBinding("stardew", "Mine", "generation_01", 1));
        var harness = new ManagerHarness(NotAtFarm(), customRefStore: references);

        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_stale", new NavigationDestinationSelector("ref", null, staleRef), Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("destination_selector_stale");
        receipt.Evidence.Should()
            .Contain("selector=ref;stale=expired;handle_age_ms=")
            .And.Contain("handle_lifetime_ms=300000")
            .And.Contain("next_step=observe_the_published_destinations");
    }

    /// <summary>
    /// The three conditions the store tells apart must not arrive as one word: `round85`'s stale handle was an expiry,
    /// and a destination set that moved is a different thing for the caller to do about it.
    /// </summary>
    [Fact]
    public void AStaleRefFromAnotherDestinationGeneration_NamesTheGenerationNotTheClock()
    {
        var references = new NavigationReferenceStore();
        var issuedAt = new NavigationBindingContext("runtime_01", Scope, "generation_old", 1, DateTimeOffset.UtcNow);
        string staleRef = references.IssueDestination(issuedAt, new NavigationDestinationBinding("stardew", "Mine", "generation_old", 1));
        var harness = new ManagerHarness(NotAtFarm(), customRefStore: references);

        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_stale_generation", new NavigationDestinationSelector("ref", null, staleRef), Deadline());

        receipt.ReasonCode.Should().Be("destination_selector_stale");
        receipt.Evidence.Should().Contain("stale=source_generation_changed").And.NotContain("handle_age_ms");
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

    /// <summary>
    /// A DOOR leg is how an interior is entered, so the navigation arms the walk to it and commits it like any other leg.
    ///
    /// <para>
    /// The old answer here was <c>blocked / destination_access_indeterminate</c> with nothing armed, because the planner
    /// refused the whole topology on the first <c>IsDoor</c> leg (<c>route_topology_invalid</c>). That made the carpenter's,
    /// Pierre's and the community centre permanently unreachable; the crossing itself is now the native door entry, pinned
    /// by <c>NavigationDoorCrossingSourceShapeTests</c>, and this harness's seam stands in for the native act.
    /// </para>
    /// </summary>
    [Fact]
    public void DoorLeg_ArmsAndCommitsLikeAnyOtherLeg()
    {
        var doorLeg = new NavigationTransitionLeg("Mine", 5, 5, 6, 6, IsDoor: true);
        var harness = new ManagerHarness(View(true, true, "Farm", at: false, new[] { doorLeg }));

        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_door", Label("Mine"), Deadline());

        receipt.State.Should().Be(ExecutionState.Accepted);
        harness.Armed.Should().ContainSingle("the door is the leg to walk, so the approach is armed");
        harness.Manager.IsBodySettled.Should().BeFalse();

        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        harness.Commits.Should().Be(1, "the accepted leg is committed once, through the one native act");
        harness.Stored("req_door").State.Should().NotBe(ExecutionState.Blocked);
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
        receipt.ReasonCode.Should().Be(
            "navigation_warp_arrived_on_another_map",
            "the MAP was the side that disagreed, and the receipt names it rather than saying \"the postcondition failed\"");
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    /// <summary>
    /// The arrival PREDICATE is a different side from the map: an event that is not this actor's arrival compared no
    /// destination at all, so it cannot be reported as "arrived somewhere else" (`round84` shared one code for both).
    /// </summary>
    [Fact]
    public void WarpEventForAnotherFarmer_NamesTheArrivalPredicate()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.RequestNavigate("req_remote", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        harness.CompleteWarp(SourceFarm, "Mine", 20, 20, isLocalPlayer: false);

        var receipt = harness.Stored("req_remote");
        receipt.State.Should().Be(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().Be("navigation_warp_not_local_player");
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    [Fact]
    public void WarpLandingTileOffset_OnTargetMap_ContinuesNotMismatch()
    {
        // Stardew may adjust the exact landing tile after a warp (collision,
        // standability, spawn offset). The warp postcondition is the target map
        // identity; the arrival rule (AtDestination) still governs the terminal.
        var harness = new ManagerHarness(NotAtFarm());
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_landoff", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();

        // Warp lands on the target map (Mine) but not on the leg's declared tile.
        harness.CompleteWarp(SourceFarm, "Mine", 21, 17);

        // The landing tile offset must not be read as a postcondition mismatch;
        // on the target map the real arrival rule decides the terminal.
        var receipt = harness.Stored("req_landoff");
        receipt.State.Should().NotBe(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().NotBe("navigation_warp_arrived_on_another_map");
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

        // Exactly one execution lineage is present. There is no body-trace channel left to carry route state: the
        // executor publishes the settlement and nothing about the body on the way to it.
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
        // No accepted lineage and no active ownership.
        harness.Manager.CancelActiveForFixture("teardown").ReasonCode.Should().Be("no_active_execution");
    }

    /// <summary>
    /// THE LIVE FAILURE, `round89` days 1 and 3: `Backwoods`' east exit to the Mountain is entered from the tile its own
    /// map puts a Bush on (`entry_blocked_by:large:Bush@49,10`), and `navigate_to_destination` settled
    /// `navigation_approach_unavailable` with `never_retry=true` while `Backwoods -> BusStop -> Town -> Mountain` was
    /// published the whole time.
    ///
    /// <para>
    /// RED BEFORE THE FIX: `Rejected`/`navigation_approach_unavailable`, nothing armed, and the second route never asked
    /// for. The assertion is about the OTHER route, never about the bush: the world is what it is, and what the execution
    /// owes it is one more question to the planner before it gives up.
    /// </para>
    /// </summary>
    [Fact]
    public void BlockedApproach_WithAnotherPublishedRoute_ArmsThatRouteAndDoesNotSettle()
    {
        var harness = new ManagerHarness(
            View(true, true, "Backwoods", at: false, new[] { MountainEastExit, BackwoodsBusStop }),
            evaluateCandidate: BlockedBackwoodsEastExit,
            topologySources: BackwoodsTopology());

        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_route", Label("Mine"), Deadline());

        receipt.State.Should().Be(ExecutionState.Accepted);
        receipt.ReasonCode.Should().Be("accepted");
        receipt.Evidence.Should().Contain("route_replanned=true");
        receipt.Evidence.Should().Contain($"refused={MountainEastExit.TargetLocation}@{MountainEastExit.SourceX},{MountainEastExit.SourceY}");
        harness.Armed.Should().ContainSingle();
        harness.Armed[0].TargetTile.Should().Be(new Vector2(49, 30), "the BusStop exit's west face is the walkable way out");
        harness.Manager.IsBodySettled.Should().BeFalse();
    }

    /// <summary>
    /// The same refusal ONE LEG LATER, which is the shape the live receipt actually had
    /// (`phase=multi_hop;approach=unavailable;never_retry=true...`): a blocked approach on a later leg must re-plan too
    /// rather than settle the whole action.
    /// </summary>
    [Fact]
    public void BlockedApproach_OnALaterLeg_ArmsTheOtherRouteInsteadOfSettling()
    {
        var harness = new ManagerHarness(
            View(true, true, "Farm", at: false, new[] { FarmToBackwoods }),
            evaluateCandidate: BlockedBackwoodsEastExit,
            topologySources: FarmToBackwoodsTopology());

        harness.Manager.RequestNavigate("req_hop", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.CompleteWarp("Farm", "Backwoods", 40, 0);

        LocalExecutionReceipt receipt = harness.Stored("req_hop");
        receipt.State.Should().Be(ExecutionState.Running);
        receipt.ReasonCode.Should().Be("navigation_multi_hop_leg_armed");
        receipt.Evidence.Should().Contain("route_replanned=true");
        harness.Armed.Should().HaveCount(2);
        harness.Armed[1].TargetTile.Should().Be(new Vector2(49, 30));
    }

    /// <summary>
    /// THE SAME BLOCKED EXIT ONE PHASE LATER, which is the other half of `round89` and the half that settled: the entry
    /// cell the plan committed to was STANDABLE (a body may stand on it), so the arm succeeded and only the walk could
    /// answer that she cannot get there. `Approaching` then ate `no_native_path` and the whole action settled
    /// `navigation_approach_unavailable` with `never_retry=true`, while `Backwoods -> BusStop -> Town -> Mountain` was
    /// published the whole time.
    ///
    /// <para>
    /// RED BEFORE THE FIX: `Uncertain`/`navigation_approach_unavailable`, two arms, and the BusStop route never asked for.
    /// </para>
    /// </summary>
    [Fact]
    public void AnUnwalkableApproach_AfterTheArm_ReplansToTheOtherRouteInsteadOfSettling()
    {
        var harness = new ManagerHarness(
            View(true, true, "Farm", at: false, new[] { FarmToBackwoods }),
            evaluateCandidate: _ => true,
            topologySources: FarmToBackwoodsTopology());

        harness.Manager.RequestNavigate("req_walk", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.CompleteWarp("Farm", "Backwoods", 40, 0);
        harness.Armed.Should().HaveCount(2, "the east exit's entry cell is standable, so the plan commits to it");
        harness.Armed[1].TargetTile.Should().Be(new Vector2(49, 10));

        // THE ENGINE ANSWERS WHAT STANDABILITY COULD NOT: there is no road from here to the cell in front of the exit.
        harness.Emit(ExecutionState.Failed, "no_native_path",
            "from=40,0;to=49,10;location=Backwoods;native=attempted;blocked_by=large:Bush@49,10");

        LocalExecutionReceipt receipt = harness.Stored("req_walk");
        receipt.State.Should().Be(ExecutionState.Running, "an exit the body cannot walk is not the end of the navigation");
        receipt.ReasonCode.Should().Be("navigation_multi_hop_leg_armed");
        receipt.Evidence.Should().Contain("route_replanned=true");
        receipt.Evidence.Should().Contain($"refused={MountainEastExit.TargetLocation}@{MountainEastExit.SourceX},{MountainEastExit.SourceY}");
        harness.Armed.Should().HaveCount(3);
        harness.Armed[2].TargetTile.Should().Be(new Vector2(49, 30), "the BusStop exit is the route that is actually walkable");
        harness.Manager.IsBodySettled.Should().BeFalse();
    }

    /// <summary>
    /// The same refusal when the published topology holds NOTHING ELSE: the settlement has to be worth its
    /// `never_retry=true`, so it names the exit the walk refused and the planner's own answer to the retry - the two
    /// facts `round89`'s receipt did not carry.
    ///
    /// <para>
    /// RED BEFORE THE FIX: `no_native_path` plus `phase=approaching;controller_traversal=true` and no statement about any
    /// other route at all, so a reader could not tell a wall from an unfinished search.
    /// </para>
    /// </summary>
    [Fact]
    public void AnUnwalkableApproach_WithNoOtherRoute_SettlesAndNamesTheRouteItRefused()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.RequestNavigate("req_walk_only", Label("Mine"), Deadline());

        harness.Emit(ExecutionState.Failed, "no_native_path", "from=0,0;to=9,10;native=attempted;blocked_by=none");

        LocalExecutionReceipt receipt = harness.Stored("req_walk_only");
        receipt.State.Should().Be(ExecutionState.Uncertain);
        receipt.ReasonCode.Should().Be("navigation_approach_unavailable");
        receipt.Evidence.Should().Contain("never_retry=true");
        receipt.Evidence.Should().Contain("routes_considered=1");
        receipt.Evidence.Should().Contain($"refused={MineLeg.TargetLocation}@{MineLeg.SourceX},{MineLeg.SourceY}");
        receipt.Evidence.Should().Contain("retry=destination_unreachable", "the planner was asked again and answered from the same topology");
        harness.Armed.Should().HaveCount(1);
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    /// <summary>
    /// ③ `never_retry=true` has to be EARNED. With no second route in the published topology the settlement names the
    /// route it refused and the planner's own answer to the retry, so "there is no other way" is a measured fact rather
    /// than a shrug - which is exactly what the live receipt could not say.
    /// </summary>
    [Fact]
    public void OnlyPublishedRouteBlocked_SettlesNeverRetryAndNamesTheRefusedRoute()
    {
        var harness = new ManagerHarness(NotAtFarm(), evaluateCandidate: _ => false);

        LocalExecutionReceipt receipt = harness.Manager.RequestNavigate("req_only", Label("Mine"), Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("navigation_approach_unavailable");
        receipt.Evidence.Should().Contain("never_retry=true");
        receipt.Evidence.Should().Contain("routes_considered=1");
        receipt.Evidence.Should().Contain($"refused={MineLeg.TargetLocation}@{MineLeg.SourceX},{MineLeg.SourceY}");
        receipt.Evidence.Should().Contain("retry=destination_unreachable");
        harness.Armed.Should().BeEmpty();
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
    }

    [Fact]
    public void NavigationLineage_ApproachProgressCarriesNoPositionInItsReceipt()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.RequestNavigate("req_no_trace", Label("Mine"), Deadline());
        harness.Emit(ExecutionState.MeaningfulProgress, "controller_progress", "target=10,10");
        harness.Emit(ExecutionState.Failed, "native_path_ended", "route_broken");

        // The only statement the bridge now receives about the approach is this lineage's receipt, and it must carry
        // neither the private target coordinate nor a tile from the body's own progress.
        LocalExecutionReceipt settled = harness.Stored("req_no_trace");
        settled.State.Should().Be(ExecutionState.Failed);
        settled.Evidence!.Should().NotContain("10,10").And.NotContain("target=").And.NotContain("tile=");
    }

    [Fact]
public void ProductionConstruction_UsesRealApproachNativeWithoutTestAuthorization()
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
    public void SuccessfulNavigation_AttachesPiggybackedScene_WhenProviderSucceeds()
    {
        var harness = new ManagerHarness(NotAtFarm());
        ObserveSceneResultPayload scene = new(
            "so1_ABCDEFGHIJKLMNOPQRSTUV",
            "Mine",
            "Mine",
            new[] { new ObserveSceneAffordancePayload("sr1_abcdeF0123456789", "chest", "Chest", 1, "East", null) },
            "1 actionable objects visible in Mine.",
            false,
            null);
        harness.Manager.SetNavigationPiggybackedSceneProvider(() => scene);

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_pb_ok", Label("Mine"), Deadline());
        accepted.State.Should().Be(ExecutionState.Accepted);
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.CompleteWarp(SourceFarm, "Mine", 20, 20);

        LocalExecutionReceipt terminal = harness.Stored("req_pb_ok");
        terminal.State.Should().Be(ExecutionState.Succeeded);
        terminal.ReasonCode.Should().Be("navigation_completed");
        terminal.PiggybackedScene.Should().NotBeNull();
        terminal.PiggybackedScene!.ObservationId.Should().Be("so1_ABCDEFGHIJKLMNOPQRSTUV");
        terminal.PiggybackedScene.CurrentLocation.Should().Be("Mine");
        terminal.PiggybackedScene.Affordances.Should().HaveCount(1);
        terminal.PiggybackedScene.Affordances[0].Ref.Should().Be("sr1_abcdeF0123456789");
    }

    [Fact]
    public void SuccessfulNavigation_NoPiggybackedScene_WhenProviderFailsOrAbsent()
    {
        var harness = new ManagerHarness(NotAtFarm());
        // Absent provider: no attachment, navigation still succeeds.
        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_pb_none", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.CompleteWarp(SourceFarm, "Mine", 20, 20);
        LocalExecutionReceipt terminal = harness.Stored("req_pb_none");
        terminal.State.Should().Be(ExecutionState.Succeeded);
        terminal.PiggybackedScene.Should().BeNull();
    }

    [Fact]
    public void SuccessfulNavigation_NoPiggybackedScene_WhenProviderThrows()
    {
        var harness = new ManagerHarness(NotAtFarm());
        harness.Manager.SetNavigationPiggybackedSceneProvider(() => throw new InvalidOperationException("scene unavailable"));

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_pb_throw", Label("Mine"), Deadline());
        accepted.State.Should().Be(ExecutionState.Accepted);
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.CompleteWarp(SourceFarm, "Mine", 20, 20);

        // Attachment failure must never revoke the already-completed navigation.
        LocalExecutionReceipt terminal = harness.Stored("req_pb_throw");
        terminal.State.Should().Be(ExecutionState.Succeeded);
        terminal.ReasonCode.Should().Be("navigation_completed");
        terminal.PiggybackedScene.Should().BeNull();
    }

    [Fact]
    public void FailedNavigation_DoesNotAttachPiggybackedScene()
    {
        var harness = new ManagerHarness(NotAtFarm());
        ObserveSceneResultPayload scene = new(
            "so1_ABCDEFGHIJKLMNOPQRSTUV",
            "Mine",
            "Mine",
            Array.Empty<ObserveSceneAffordancePayload>(),
            "no objects",
            false,
            null);
        harness.Manager.SetNavigationPiggybackedSceneProvider(() => scene);

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_pb_fail", Label("Mine"), Deadline());
        accepted.State.Should().Be(ExecutionState.Accepted);
        // Non-success settle (e.g. deadline/blocked) must not attach the scene.
        harness.Emit(ExecutionState.Rejected, "navigation_approach_unavailable", "phase=approaching;arm=failed");

        LocalExecutionReceipt terminal = harness.Stored("req_pb_fail");
        terminal.State.Should().Be(ExecutionState.Rejected);
        terminal.PiggybackedScene.Should().BeNull();
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
    public void MultiHop_PublishesOnlyItsOneSettlement()
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

        // Two hops, two warps and two settled approaches reach the bridge as ONE statement: the lineage's settlement.
        LocalExecutionReceipt settled = harness.Stored("req_mt_trace");
        settled.State.Should().Be(ExecutionState.Succeeded);
        settled.ReasonCode.Should().Be("navigation_completed");
        harness.Manager.IsBodySettled.Should().BeTrue();
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

    [Fact]
    public void LockedWarpFrame_DeferredReplan_ThenActsWhenPlayerActionable()
    {
        // After the first native warp the fresh world view reports
        // PlayerActionable=false for one transition frame (CanMove=false). The
        // navigation must NOT settle a healthy multi-hop as destination_locked;
        // it defers the next leg and replans once the player is actionable again.
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
            },
            // The first post-warp replan sees a locked frame; the retry sees the
            // authentic actionable Mountain view and arms the second leg.
            lockedSecondView: View(true, false, "Mountain", at: false, new[] { mountainToMine }));

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_defer_lock", Label("Mine"), Deadline());
        accepted.State.Should().Be(ExecutionState.Accepted);

        // First leg: approach → commit → warp
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.Commits.Should().Be(1);

        // Warp lands while the player is momentarily not actionable: the next leg
        // is deferred, never settled as destination_locked, and never armed twice.
        harness.CompleteWarp("Farm", "Mountain", 2, 2);
        harness.Armed.Should().HaveCount(1);
        harness.Manager.IsBodySettled.Should().BeFalse();
        harness.Manager.TryGetReceipt("req_defer_lock", out LocalExecutionReceipt? afterLockedFrame).Should().BeTrue();
        afterLockedFrame!.State.Should().NotBe(ExecutionState.Rejected);
        afterLockedFrame.ReasonCode.Should().NotBe("destination_locked");

        // On a later tick the player is actionable again: the deferred replan
        // arms the second leg (and only arms it once).
        harness.Manager.Update();
        harness.Armed.Should().HaveCount(2);
        harness.Manager.IsBodySettled.Should().BeFalse();

        // The navigation continues to its single terminal.
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.Commits.Should().Be(2);
        harness.CompleteWarp("Mountain", "Mine", 4, 4);

        var receipt = harness.Stored("req_defer_lock");
        receipt.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("navigation_completed");
        receipt.ExecutionId.Should().Be(accepted.ExecutionId);
        harness.Manager.IsBodySettled.Should().BeTrue();
    }

    [Fact]
    public void LockedWarpFrame_PersistentLockedPlayer_SettlesDestinationLockedAfterGrace()
    {
        // A player who genuinely cannot act after the warp (event/menu) must not
        // hang forever: after the grace window the deferred replan settles
        // fail-closed as destination_locked exactly once, with no second line.
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
            },
            // The player is genuinely unable to act on the first post-warp frame:
            // the fresh world reports PlayerActionable=false, so the replan defers.
            lockedSecondView: View(true, false, "Mountain", at: false, new[] { mountainToMine }));

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_defer_grace", Label("Mine"), Deadline());
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.Commits.Should().Be(1);

        // The player stays not actionable (probe disabled) after the warp, so the
        // deferred replan never arms. The grace window must still bound it.
        harness.CompleteWarp("Farm", "Mountain", 2, 2);
        harness.PlayerActionableProbe = () => false;
        harness.Armed.Should().HaveCount(1);

        // Drive past the grace window (`NavigationWarpReplanGraceTicks`, the engine's own retry window).
        for (int i = 0; i < 200; i++)
            harness.Manager.Update();

        var receipt = harness.Stored("req_defer_grace");
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("destination_locked");
        receipt.ExecutionId.Should().Be(accepted.ExecutionId);
        harness.Manager.IsBodySettled.Should().BeTrue();
        harness.Armed.Should().HaveCount(1);
        harness.Commits.Should().Be(1);
    }

    [Fact]
    public void PersistentPostWarpHold_IsBoundedByOneWindow_AndSettlesInsteadOfHoldingTheBodyForever()
    {
        // The body may not be held with no way out. After the first warp the destination reads locked (a hold the fresh
        // world keeps reporting) while the manager's OWN actionability probe answers true - two readings of one question
        // that disagree. Every retry inside the window re-read `destination_locked`, and re-arming the window from that
        // retry meant the window it was supposed to bound could never expire: the navigation kept the body with no
        // terminal, published nothing, and the caller's ten-minute deadline was the only thing left that could end it.
        var harness = new PersistentLockHarness();

        LocalExecutionReceipt accepted = harness.Manager.RequestNavigate("req_lock_persist", Label("Mine"), Deadline());
        accepted.State.Should().Be(ExecutionState.Accepted, $"{accepted.ReasonCode} / {accepted.Evidence}");
        harness.EmitApproachSucceeded();
        harness.Manager.Update();
        harness.Commits.Should().Be(1);

        // The warp lands and the world it lands in is still locked.
        harness.CompleteWarp("Farm", "Mountain", 2, 2);
        harness.Armed.Should().HaveCount(1, "a locked read arms nothing");
        harness.Manager.IsBodySettled.Should().BeFalse("the lineage still owns the body inside its window");

        // Drive well past the window. The window is armed ONCE per warp and its retries do not move it.
        for (int i = 0; i < 400; i++)
            harness.Manager.Update();

        LocalExecutionReceipt terminal = harness.Stored("req_lock_persist");
        terminal.ExecutionId.Should().Be(accepted.ExecutionId);
        terminal.State.Should().Be(ExecutionState.Rejected);
        terminal.ReasonCode.Should().Be("destination_locked");
        harness.Manager.IsBodySettled.Should().BeTrue("an owner that can hold the body must have a way out");

        // The way out NAMES ITSELF. MEASURED round68: this terminal read
        // `destination=Town;phase=awaiting_warp;grace_expired=true;actionable=false;never_retry=true` and the run ended,
        // because nothing in it said what held her or what to do next. The hold comes from the one vocabulary that
        // describes a held body, the window states its own length, and the ledger's `never_retry` is not published as if
        // it were an instruction about the world.
        terminal.Evidence.Should().Contain("held_by=", "a refusal has to say WHAT holds the actor");
        terminal.Evidence.Should().Contain("grace_expired=true");
        terminal.Evidence.Should().Contain(
            $"window_ticks={WorldModel.TransientRetryWindowTicks}",
            "the wait that ended states its own length, read from the one declaration of it");
        terminal.Evidence.Should().NotContain("never_retry=true", "nothing was mutated by ending the wait");
        (terminal.Evidence!.Contains("next_step=", StringComparison.Ordinal)
            || terminal.Evidence!.Contains("admissible_actions=", StringComparison.Ordinal))
            .Should().BeTrue($"and what to do next, from the hold's own countermeasure ({terminal.Evidence})");

        // And the way out is single: further ticks do not mint a second terminal.

        // And the way out is single: further ticks do not mint a second terminal.
        for (int i = 0; i < 10; i++)
            harness.Manager.Update();
        harness.Stored("req_lock_persist").ReasonCode.Should().Be("destination_locked");
    }

    [Fact]
    public void ACutsceneHoldAfterAWarp_IsNotExpiredByTheReplanWindow_BecauseTheWorldEndsItByItself()
    {
        // MEASURED `1795084502755`: just after the warp into `Mine` a `navigate_to_destination(Mine)` settled
        // `destination_locked` with `grace_expired=true;held_by=cutscene_active`. The event was still running and the
        // destination was still reachable, so the window ended a navigation the world was about to release. A holder that
        // ends by itself is not a deadline this Mod may expire: `BodyHoldWait.RequestDeadline` - the wait the flat
        // admission already gives an event - bounds it instead, and that is the navigation's own deadline.
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
            },
            lockedSecondView: View(true, false, "Mountain", at: false, new[] { mountainToMine }));

        bool eventWasUp = Game1.eventUp;
        try
        {
            harness.Manager.RequestNavigate("req_cutscene_hold", Label("Mine"), Deadline());
            harness.EmitApproachSucceeded();
            harness.Manager.Update();
            harness.CompleteWarp("Farm", "Mountain", 2, 2);
            harness.PlayerActionableProbe = () => false;
            // The hold the world owns: `Classify` reads `Game1.eventUp` and the disposition becomes `Event`, whose declared
            // wait is the request's deadline.
            Game1.eventUp = true;

            for (int i = 0; i < 400; i++)
                harness.Manager.Update();

            harness.Manager.TryGetReceipt("req_cutscene_hold", out LocalExecutionReceipt? held).Should().BeTrue();
            held!.ReasonCode.Should().NotBe("destination_locked", $"the event ends by itself, so no window of ours may end the walk first ({held.Evidence})");
            harness.Manager.IsBodySettled.Should().BeFalse("the navigation still owns the body it is waiting to finish with");
            harness.Armed.Should().HaveCount(1);
        }
        finally
        {
            Game1.eventUp = eventWasUp;
        }
    }

    [Fact]
    public void ACutsceneHoldThatOutlastsTheNavigation_SettlesAtTheRequestsOwnDeadline_NamingTheHoldAndTheStep()
    {
        // The other half of the rule: not expiring the window is not hanging. The request's own deadline still bounds it,
        // and the terminal it mints then says WHO held her and WHAT the caller can do - the two facts `round68` found
        // missing when `never_retry=true` was the whole sentence.
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
            },
            lockedSecondView: View(true, false, "Mountain", at: false, new[] { mountainToMine }));

        bool eventWasUp = Game1.eventUp;
        try
        {
            long shortDeadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1_500;
            harness.Manager.RequestNavigate("req_cutscene_deadline", Label("Mine"), shortDeadline);
            harness.EmitApproachSucceeded();
            harness.Manager.Update();
            harness.CompleteWarp("Farm", "Mountain", 2, 2);
            harness.PlayerActionableProbe = () => false;
            Game1.eventUp = true;

            Thread.Sleep(1_600);
            harness.Manager.Update();

            LocalExecutionReceipt terminal = harness.Stored("req_cutscene_deadline");
            terminal.State.Should().Be(ExecutionState.Uncertain);
            terminal.ReasonCode.Should().Be("navigation_deadline_expired_after_warp");
            terminal.Evidence.Should().Contain("held_by=cutscene_active", $"the terminal has to say what held her ({terminal.Evidence})");
            terminal.Evidence.Should().Contain(
                "next_step=wait_for_event_to_advance",
                "and the hold's own countermeasure, which is more specific than the table's generic word");
        }
        finally
        {
            Game1.eventUp = eventWasUp;
        }
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

    private static readonly NavigationTransitionLeg MountainEastExit = new("Mountain", 50, 10, 30, 31, IsDoor: false);
    private static readonly NavigationTransitionLeg BackwoodsBusStop = new("BusStop", 50, 30, 11, 8, IsDoor: false);
    private static readonly NavigationTransitionLeg FarmToBackwoods = new("Backwoods", 40, -1, 49, 30, IsDoor: false);

    /// <summary>
    /// The four faces of the Backwoods' east exit `(50,10)`, exactly as the live world has them: `(49,10)` holds the map's
    /// own Bush (`entry_blocked_by:large:Bush@49,10`) and the other three are off-map, so no body can stand on any of them.
    /// </summary>
    private static bool BlockedBackwoodsEastExit(Vector2 tile) =>
        tile != new Vector2(49, 10)
        && tile != new Vector2(51, 10)
        && tile != new Vector2(50, 9)
        && tile != new Vector2(50, 11);

    /// <summary>
    /// The TWO ways out of the Backwoods the world publishes: the east edge onto the Mountain, and the BusStop road that
    /// reaches the Mountain through Town. Both are warp legs of the same topology the production source builds from the
    /// map - nothing here is invented to make a retry possible.
    /// </summary>
    private static IReadOnlyDictionary<string, IReadOnlyList<NavigationTransitionLeg>> BackwoodsTopology() =>
        new Dictionary<string, IReadOnlyList<NavigationTransitionLeg>>(StringComparer.Ordinal)
        {
            ["Backwoods"] = new[] { MountainEastExit, BackwoodsBusStop },
            ["BusStop"] = new[] { new NavigationTransitionLeg("Town", 11, 8, 60, 60, IsDoor: false) },
            ["Town"] = new[] { new NavigationTransitionLeg("Mountain", 79, -1, 30, 31, IsDoor: false) },
            ["Mountain"] = new[] { new NavigationTransitionLeg("Mine", 31, 20, 4, 4, IsDoor: false) },
            ["Mine"] = Array.Empty<NavigationTransitionLeg>(),
        };

    /// <summary>The same topology entered from the Farm, so the blocked leg is the SECOND one the execution plans.</summary>
    private static IReadOnlyDictionary<string, IReadOnlyList<NavigationTransitionLeg>> FarmToBackwoodsTopology() =>
        new Dictionary<string, IReadOnlyList<NavigationTransitionLeg>>(StringComparer.Ordinal)
        {
            ["Farm"] = new[] { FarmToBackwoods },
            ["Backwoods"] = new[] { MountainEastExit, BackwoodsBusStop },
            ["BusStop"] = new[] { new NavigationTransitionLeg("Town", 11, 8, 60, 60, IsDoor: false) },
            ["Town"] = new[] { new NavigationTransitionLeg("Mountain", 79, -1, 30, 31, IsDoor: false) },
            ["Mountain"] = new[] { new NavigationTransitionLeg("Mine", 31, 20, 4, 4, IsDoor: false) },
            ["Mine"] = Array.Empty<NavigationTransitionLeg>(),
        };

    /// <summary>
    /// The hold these fixtures publish for a body the game has not described further, in <see cref="WorldModel"/>'s own
    /// words rather than a second copy of them.
    /// </summary>
    private static readonly string NotActionableHold = WorldModel.DescribeHeldBody(default, canMove: false, hold: BodyHoldFact.Free).Evidence;

    private static NavigationWorldView View(bool live, bool actionable, string source, bool at, IReadOnlyList<NavigationTransitionLeg> legs)
        => new(live, actionable ? null : NotActionableHold, source, 0, 0, at, legs, BoundaryExcludesDestination: false, DestinationTemporarilyUnavailable: false, TransitionAmbiguousOrUnknown: false, UncorrelatedTransition: false);

    /// <summary>Mutable fake world source so the fresh coordinator re-read can change.</summary>
    private sealed class MutableWorldSource : INavigationWorldSource
    {
        private readonly NavigationWorldView normal;
        private NavigationWorldView? destination;
        internal MutableWorldSource(NavigationWorldView normal) => this.normal = normal;
        internal string? CurrentSourceLocation => (this.destination ?? this.normal).CurrentSourceLocation;
        internal void MoveToDestination() => this.destination = View(true, true, "Mine", at: true, Array.Empty<NavigationTransitionLeg>());
        internal void ObserveLocation(string location, bool atDestination, IReadOnlyList<NavigationTransitionLeg>? legs = null) =>
            this.destination = View(true, true, location, atDestination, legs ?? Array.Empty<NavigationTransitionLeg>());
        public NavigationWorldView CurrentView(NavigationDestinationBinding binding) => this.destination ?? this.normal;
    }
    /// <summary>Connectivity source that serves one declared topology, keyed on the source the world most recently read.</summary>
    private sealed class FixedTopologyConnectivitySource : INavigationConnectivitySource
    {
        private readonly MutableWorldSource world;
        private readonly IReadOnlyDictionary<string, IReadOnlyList<NavigationTransitionLeg>> sources;

        internal FixedTopologyConnectivitySource(
            MutableWorldSource world,
            IReadOnlyDictionary<string, IReadOnlyList<NavigationTransitionLeg>> sources)
        {
            this.world = world;
            this.sources = sources;
        }

        public bool TryCreateCurrentOrdinaryWarpTopology(
            NavigationDestinationBinding acceptedBinding,
            out NavigationOrdinaryWarpTopology? topology,
            out string reasonCode)
        {
            string? current = this.world.CurrentSourceLocation;
            if (current is null || !this.sources.ContainsKey(current))
            {
                topology = null;
                reasonCode = "source_not_in_topology";
                return false;
            }
            topology = new NavigationOrdinaryWarpTopology(
                current,
                this.sources.Select(kvp => new NavigationOrdinaryWarpLegs(kvp.Key, kvp.Value)).ToArray());
            reasonCode = "accepted";
            return true;
        }
    }

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
            DerivedDestinationSet? customSet = null,
            IReadOnlyDictionary<string, IReadOnlyList<NavigationTransitionLeg>>? topologySources = null)
        {
            this.Manager = new ExecutionManager(new DummyMonitor(), Surface());
            this.Source = new MutableWorldSource(initial);
            var references = customRefStore ?? new NavigationReferenceStore();
            var destinations = new[] { new NavigationDestination("stardew", "Mine", "Mine", null) };
            var set = customSet ?? new DerivedDestinationSet("generation_01", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()), destinations);
            if (withRuntime)
            {
                INavigationConnectivitySource connectivity = topologySources is null
                    ? new MutableConnectivitySource(this.Source, initial.CurrentSourceLocation ?? "Farm")
                    : new FixedTopologyConnectivitySource(this.Source, topologySources);
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
        internal void CompleteWarp(string oldLocation, string newLocation, int newTileX, int newTileY, bool isLocalPlayer = true)
        {
            this.Source.ObserveLocation(newLocation, string.Equals(newLocation, "Mine", StringComparison.Ordinal));
            this.Manager.CompleteNavigationAfterWarp(isLocalPlayer, oldLocation, newLocation, newTileX, newTileY);
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
        internal Func<bool>? PlayerActionableProbe { get; set; }

        internal MultiHopHarness(
            NavigationWorldView initial,
            NavigationWorldView secondView,
            NavigationWorldView? arrivalView,
            Dictionary<string, IReadOnlyList<NavigationTransitionLeg>> topologySources,
            bool failConnectivityAfterFirstWarp = false,
            bool failArmAfterFirstWarp = false,
            NavigationWorldView? lockedSecondView = null)
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
            // after the correlated warp callback. A locked frame option injects
            // a PlayerActionable=false view for the first post-warp replan so the
            // deferred-replan lifecycle is provable; the retry then reads the
            // authentic second view, and the second commit re-validates it once
            // more before the arrival view is finally observed.
            var worldViews = new List<NavigationWorldView> { initial, initial };
            if (lockedSecondView is not null)
            {
                worldViews.Add(lockedSecondView);   // first post-warp replan (locked frame)
                worldViews.Add(secondView);         // deferred retry replan
                worldViews.Add(secondView);         // second-leg commit revalidation
            }
            else
            {
                worldViews.Add(secondView);
                worldViews.Add(secondView);
            }
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
            this.Manager.SetNavigationPlayerActionableProbe(() => this.PlayerActionableProbe?.Invoke() ?? true);
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

    /// <summary>
    /// A multi-hop navigation whose destination stays LOCKED after the first warp, while the manager's own actionability
    /// probe keeps answering true. The two readings answer one question differently, which is the state a bound must
    /// survive: nothing else in the run will ever make that window advance.
    /// </summary>
    private sealed class PersistentLockHarness
    {
        private readonly PersistentLockWorldSource source;

        internal PersistentLockHarness()
        {
            NavigationTransitionLeg farmToMountain = new("Mountain", 1, 1, 2, 2, IsDoor: false);
            NavigationTransitionLeg mountainToMine = new("Mine", 3, 3, 4, 4, IsDoor: false);
            this.source = new PersistentLockWorldSource(
                beforeWarp: View(true, true, "Farm", at: false, new[] { farmToMountain }),
                afterWarp: View(true, false, "Mountain", at: false, new[] { mountainToMine }));
            this.Manager = new ExecutionManager(new DummyMonitor(), Surface());
            var references = new NavigationReferenceStore();
            var destinations = new[]
            {
                new NavigationDestination("stardew", "Mine", "Mine", null),
                new NavigationDestination("stardew", "Mountain", "Mountain", null),
            };
            var set = new DerivedDestinationSet("generation_01", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>()), destinations);
            this.Manager.SetNavigationRuntimeFactory(() => new NavigationRuntimeSnapshot(references, "runtime_01", Scope, () => set, this.source, new PersistentLockConnectivitySource(this.source)));
            this.Manager.SetNavigationApproachNative(new NavigationApproachNative(
                (spec, farmer, tick) => { this.Armed.Add(spec); return (true, "accepted"); },
                (farmer, leg) => new StardewValley.Warp(leg.SourceX, leg.SourceY, leg.TargetLocation, leg.TargetX, leg.TargetY, flipFarmer: false, npcOnly: false),
                (farmer, warp) => { this.Commits++; },
                _ => true));
            this.Manager.SetNavigationLifecycleTestAuthorization(() => true);
            // The manager's own reading of "may the player act" answers TRUE for the whole window, while the world read
            // the routing consumes keeps reporting a hold. That disagreement is the state the fixture holds still: the
            // deferred replan runs on every tick and every run re-reads the lock.
            this.Manager.SetNavigationPlayerActionableProbe(() => true);
        }

        internal ExecutionManager Manager { get; }

        internal List<LocalMoveSpec> Armed { get; } = new();

        internal int Commits { get; private set; }

        internal void EmitApproachSucceeded() =>
            this.Manager.EmitNavigationApproachTransition(ExecutionState.Succeeded, "target_reached", "tile=1,2;target=2,2");

        internal void CompleteWarp(string oldLocation, string newLocation, int newTileX, int newTileY)
        {
            this.source.Warp();
            this.Manager.CompleteNavigationAfterWarp(true, oldLocation, newLocation, newTileX, newTileY);
        }

        internal LocalExecutionReceipt Stored(string requestId)
        {
            this.Manager.TryGetReceipt(requestId, out LocalExecutionReceipt? receipt).Should().BeTrue();
            return receipt!;
        }
    }

    /// <summary>Two views, switched once by the warp: before it the route is open, after it the destination is locked.</summary>
    private sealed class PersistentLockWorldSource : INavigationWorldSource
    {
        private readonly NavigationWorldView beforeWarp;
        private readonly NavigationWorldView afterWarp;
        private bool warped;

        internal PersistentLockWorldSource(NavigationWorldView beforeWarp, NavigationWorldView afterWarp)
        {
            this.beforeWarp = beforeWarp;
            this.afterWarp = afterWarp;
        }

        internal void Warp() => this.warped = true;

        /// <summary>Every leg either view knows, with the location it leaves from: a leg names its source by its entry in
        /// this list, not by a field, because the wire's leg record carries only the two tiles and the target.</summary>
        internal IReadOnlyList<(string Source, NavigationTransitionLeg Leg)> AllLegs
        {
            get
            {
                var legs = new List<(string Source, NavigationTransitionLeg Leg)>();
                foreach ((string source, NavigationWorldView view) in new[]
                {
                    (this.beforeWarp.CurrentSourceLocation ?? "Farm", this.beforeWarp),
                    (this.afterWarp.CurrentSourceLocation ?? "Mountain", this.afterWarp),
                })
                {
                    foreach (NavigationTransitionLeg leg in view.OrdinaryLegs)
                        legs.Add((source, leg));
                }

                return legs;
            }
        }

        public NavigationWorldView CurrentView(NavigationDestinationBinding binding) =>
            this.warped ? this.afterWarp : this.beforeWarp;
    }

    /// <summary>Connectivity derived from whichever view the world source is reporting, so the two cannot disagree.</summary>
    private sealed class PersistentLockConnectivitySource : INavigationConnectivitySource
    {
        private readonly PersistentLockWorldSource world;

        internal PersistentLockConnectivitySource(PersistentLockWorldSource world) => this.world = world;

        public bool TryCreateCurrentOrdinaryWarpTopology(
            NavigationDestinationBinding acceptedBinding,
            out NavigationOrdinaryWarpTopology? topology,
            out string reasonCode)
        {
            // Every leg either view knows about, so the route exists before the warp and the locked read that follows it
            // is the ONLY thing that changes: the hold, not the map.
            NavigationWorldView view = this.world.CurrentView(acceptedBinding);
            string current = view.CurrentSourceLocation ?? "Farm";
            var sources = new Dictionary<string, List<NavigationTransitionLeg>>(StringComparer.Ordinal)
            {
                [acceptedBinding.CanonicalDestinationIdentity] = new List<NavigationTransitionLeg>(),
            };
            foreach ((string source, NavigationTransitionLeg leg) in this.world.AllLegs)
            {
                if (!sources.TryGetValue(source, out List<NavigationTransitionLeg>? from))
                    sources[source] = from = new List<NavigationTransitionLeg>();
                from.Add(leg);
                if (!sources.ContainsKey(leg.TargetLocation))
                    sources[leg.TargetLocation] = new List<NavigationTransitionLeg>();
            }

            topology = new NavigationOrdinaryWarpTopology(
                current,
                sources.Select(kvp => new NavigationOrdinaryWarpLegs(kvp.Key, kvp.Value)).ToArray());
            reasonCode = "accepted";
            return true;
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