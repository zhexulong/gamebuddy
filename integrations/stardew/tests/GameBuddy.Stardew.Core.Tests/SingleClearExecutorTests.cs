using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The one-clear rule and the lease that pays for it.
///
/// Three properties, and each one is the reason the type exists rather than a detail of it:
///
/// <list type="number">
/// <item>a blocker the actor cannot afford is refused BEFORE the swing - the engine does not refuse a
/// swing for lack of stamina, it lets stamina run negative and faints the actor, and a faint halves the
/// next day;</item>
/// <item>a second clear from one plan is impossible - not discouraged, impossible, because the plan that
/// named the first blocker was computed against a world that no longer exists;</item>
/// <item>a STOP between the approach and the swing starts no swing, and invalidates the lease so that
/// even a caller that ignores the refusal cannot swing.</item>
/// </list>
///
/// The stamina arithmetic is asserted as arithmetic (the numbers the engine uses), the loop pin as a
/// count, and the STOP case as "the world was never touched" - no world object is consulted for it.
/// </summary>
public sealed class SingleClearExecutorTests
{
    private static readonly ClearBlockerTile Rock = new(53, 14, "rock", "rock_target_1");
    private static readonly (int X, int Y) Approach = (52, 14);

    private static SingleClearExecutor Executor(
        float staminaAtIssue = 270f,
        long deadlineMs = 1_000_000,
        params ClearBlockerTile[] authorized)
    {
        ClearanceLease lease = ClearanceLease.Issue(
            "intent_1",
            staminaAtIssue,
            deadlineMs,
            authorized.Length == 0 ? new[] { Rock } : authorized);
        return SingleClearExecutor.Create(Rock, Approach, lease);
    }

    private static ClearSwingObservation InReach(
        float expectedCost = 16f,
        string targetId = "rock_target_1",
        bool present = true,
        bool stopped = false,
        bool inToolReach = true,
        int actorX = 52,
        int actorY = 14) =>
        new(actorX, actorY, present, present ? targetId : null, expectedCost, inToolReach, stopped);

    // ---- A: the swing is authorised only when the actor can pay for it ------------------------

    [Fact]
    public void ABlockerTheActorCannotAffordIsRefusedBeforeTheSwing()
    {
        // 8 swings at 2 stamina (a fresh 2x2 boulder and a basic pickaxe) is 16. An actor with 18 has
        // the number on paper and not the margin: 18 - 16 = 2, below the floor of 5.
        SingleClearExecutor executor = Executor(staminaAtIssue: 18f);

        SingleClearAuthorization verdict = executor.AuthorizeSwing(InReach(expectedCost: 16f), nowMs: 1);

        verdict.Allowed.Should().BeFalse("18 - 16 = 2, and the floor leaves no room to walk home");
        verdict.ReasonCode.Should().Be("insufficient_stamina");
        verdict.Evidence.Should().Contain("required_after=5");
        executor.ClearsExecuted.Should().Be(0, "a refused swing consumes nothing");
        executor.Lease.ClearsExecuted.Should().Be(0);
    }

    [Fact]
    public void AnAffordableBlockerIsAuthorisedAndTheSwingsRealCostIsWhatItCharges()
    {
        SingleClearExecutor executor = Executor(staminaAtIssue: 40f);

        executor.AuthorizeSwing(InReach(expectedCost: 16f), nowMs: 1).Allowed.Should().BeTrue();

        // The ESTIMATE authorised the swing; the REAL delta is what the lease pays. They differ here on
        // purpose: the engine took 18.5, not the 16 the pre-flight predicted, and a lease that charged
        // the estimate would spend the player's day on a number nobody measured.
        executor.RecordClear(actualStaminaCost: 18.5f);

        executor.ClearsExecuted.Should().Be(1);
        executor.Lease.ClearsExecuted.Should().Be(1);
        executor.Lease.RemainingStamina.Should().BeApproximately(21.5f, 1e-4f);
    }

    [Fact]
    public void TheLeaseRefusesOnceTheGuardWouldRefuse()
    {
        // The lease must not be a second, softer floor. Drive the same numbers through both and assert
        // they agree, so a lease that drifted from the shared guard fails here rather than in a live run.
        foreach (float stamina in new[] { 40f, 21f, 20.9f, 5.1f, 5f, 0f })
        {
            ToolStaminaVerdict guard = ToolStaminaGuard.Check(stamina, 16f);
            SingleClearExecutor executor = Executor(staminaAtIssue: stamina);

            SingleClearAuthorization lease = executor.AuthorizeSwing(InReach(expectedCost: 16f), nowMs: 1);

            lease.Allowed.Should().Be(guard.Allowed, $"the lease and the guard must answer the same question at stamina={stamina}");
        }
    }

    [Fact]
    public void ABlockerOutsideTheLeaseIsRefusedWithTheStepAttached()
    {
        // A rock that appeared while the actor walked. It is NOT added to the lease: the executor reports
        // it as out of scope and the caller decides whether the intent is worth widening.
        SingleClearExecutor executor = Executor();
        var discovered = new ClearBlockerTile(52, 13, "rock", "rock_target_2");

        ClearanceDecision decision = executor.Lease.TryAuthorize(discovered, 4f, nowMs: 1);

        decision.Allowed.Should().BeFalse();
        decision.ReasonCode.Should().Be(ClearanceLease.BlockerOutsideLeaseReasonCode);
        decision.Evidence.Should().Contain("discovered=rock@52,13");
        decision.Evidence.Should().Contain("authorized=rock@53,14");
        executor.Lease.RemainingStamina.Should().Be(270f, "a discovered blocker spends nothing, because it was never authorised");
    }

    // ---- B: the lease bounds the intent, and STOP ends it ------------------------------------

    [Fact]
    public void AnExpiredLeaseRefusesEvenAnAffordableClear()
    {
        // The boundary is a deadline, not a count of tiles: an intent that has run past its time is over
        // however cheap the next rock happens to be.
        SingleClearExecutor executor = Executor(deadlineMs: 1_000);

        executor.AuthorizeSwing(InReach(), nowMs: 999).Allowed.Should().BeTrue();
        SingleClearAuthorization late = executor.AuthorizeSwing(InReach(), nowMs: 1_000);

        late.Allowed.Should().BeFalse();
        late.ReasonCode.Should().Be(ClearanceLease.ExpiredReasonCode);
    }

    [Fact]
    public void AStopBetweenTheApproachAndTheSwingStartsNoSwing()
    {
        // The whole case is "nothing was touched": the swing is refused, the lease ends, and a caller that
        // ignores the refusal cannot swing on its second attempt either.
        SingleClearExecutor executor = Executor();

        SingleClearAuthorization stopped = executor.AuthorizeSwing(InReach(stopped: true), nowMs: 1);

        stopped.Allowed.Should().BeFalse();
        stopped.ReasonCode.Should().Be(SingleClearExecutor.StoppedReasonCode);
        stopped.Evidence.Should().Contain("swing_started=false");
        executor.ClearsExecuted.Should().Be(0, "a stop before the swing leaves nothing to undo");
        executor.Lease.IsValid.Should().BeFalse("STOP invalidates the lease, not just this one attempt");

        SingleClearAuthorization retry = executor.AuthorizeSwing(InReach(stopped: false), nowMs: 2);
        retry.Allowed.Should().BeFalse("the lease is already invalidated, so a second attempt cannot start a swing");
        retry.ReasonCode.Should().Be(ClearanceLease.InvalidatedReasonCode);
    }

    [Fact]
    public void TheFirstInvalidationReasonWins()
    {
        // A STOP, then a policy change: the second reason describes a lease that was already gone.
        ClearanceLease lease = ClearanceLease.Issue("intent_1", 270f, 1_000_000, new[] { Rock });

        lease.Invalidate("stop_epoch_2");
        lease.Invalidate("policy_changed");

        lease.Describe().Should().Contain("invalidated:stop_epoch_2");
        lease.InvalidReasonCode.Should().Be("stop_epoch_2");
    }

    // ---- C: one clear per plan, and the world is planned AGAIN --------------------------------

    [Fact]
    public void ASecondClearFromTheSamePlanIsImpossible()
    {
        // The plan listed three blockers. The executor clears ONE of them and then refuses every further
        // swing, whether or not the world would still allow it - so an executor wired into a loop cannot
        // clear the other two from this plan.
        var plan = new ClearingPlan(true, new[] { (53, 14), (54, 14), (55, 14) }, 9);
        SingleClearExecutor executor = Executor();
        plan.Clear.Count.Should().Be(3, "the plan proposes three clears");

        executor.AuthorizeSwing(InReach(), nowMs: 1).Allowed.Should().BeTrue();
        executor.RecordClear(16f);

        SingleClearAuthorization second = executor.AuthorizeSwing(
            new ClearSwingObservation(52, 14, true, "rock_target_1", 16f, InToolReach: true, Stopped: false),
            nowMs: 2);

        second.Allowed.Should().BeFalse();
        second.ReasonCode.Should().Be(SingleClearExecutor.SecondClearReasonCode);
        second.Evidence.Should().Contain("replan_required=true");
        executor.ClearsExecuted.Should().Be(1, "exactly one clear, however many the plan listed");
    }

    [Fact]
    public void RecordingASecondClearIsNotMerelyRefusedItIsRejected()
    {
        // The authorisation refuses, and the record call throws: there is no sequence of calls that leaves
        // this executor having executed two clears.
        SingleClearExecutor executor = Executor();
        executor.RecordClear(16f);

        ((System.Action)(() => executor.RecordClear(16f)))
            .Should().Throw<System.InvalidOperationException>()
            .WithMessage($"*{SingleClearExecutor.SecondClearReasonCode}*");
        executor.ClearsExecuted.Should().Be(1);
        executor.Lease.ClearsExecuted.Should().Be(1, "the doubled charge never happened");
    }

    [Fact]
    public void AfterTheOneClearTheFreshPlanIsWhatDecidesTheNextStep()
    {
        // The clear opened the way: the target is reachable and nothing else must be paid for.
        SingleClearExecutor open = Executor();
        open.RecordClear(16f);

        SingleClearFollowUp reachable = open.Reobserve(
            ClearReobservation.FromPlan(new ClearingPlan(true, System.Array.Empty<(int X, int Y)>(), 0), _ => null));

        reachable.TargetReachable.Should().BeTrue();
        reachable.ReasonCode.Should().Be(SingleClearExecutor.TargetReachableReasonCode);
        reachable.RemainingBlockers.Should().BeEmpty();

        // The clear did not open the way: the fresh plan names what is still in the way and nothing is
        // authorised to remove it.
        SingleClearExecutor blocked = Executor();
        blocked.RecordClear(16f);

        SingleClearFollowUp stillBlocked = blocked.Reobserve(
            ClearReobservation.FromPlan(new ClearingPlan(true, new[] { (54, 14) }, 3), tile => tile == (54, 14) ? "rock" : null));

        stillBlocked.TargetReachable.Should().BeFalse();
        stillBlocked.ReasonCode.Should().Be(SingleClearExecutor.TargetStillBlockedReasonCode);
        stillBlocked.RemainingBlockers.Should().ContainSingle()
            .Which.Describe().Should().Be("rock@54,14");
        blocked.ClearsExecuted.Should().Be(1, "reporting a remaining blocker clears nothing");
    }

    [Fact]
    public void AnUnreachableFreshPlanReportsNoBillToPay()
    {
        // `ClearingPlan.Unreachable` means no number of clears opens the way - a wall, not a bill. Reporting
        // it as "these tiles are still in the way" would hand the caller a list it cannot act on.
        SingleClearExecutor executor = Executor();
        executor.RecordClear(16f);

        SingleClearFollowUp followUp = executor.Reobserve(
            ClearReobservation.FromPlan(ClearingPlan.Unreachable, _ => null));

        followUp.TargetReachable.Should().BeFalse();
        followUp.RemainingBlockers.Should().BeEmpty();
        followUp.Evidence.Should().Contain("replan=unreachable");
    }

    // ---- the world is re-read at the swing, not trusted from the plan ------------------------

    [Fact]
    public void ABlockerThatChangedIdentityIsRefusedRatherThanCleared()
    {
        // Same tile, different object: the rock was felled and a weed grew back. Clearing it would spend
        // stamina on something nobody asked for.
        SingleClearExecutor executor = Executor();

        SingleClearAuthorization verdict = executor.AuthorizeSwing(
            InReach(targetId: "weed_target_9"),
            nowMs: 1);

        verdict.Allowed.Should().BeFalse();
        verdict.ReasonCode.Should().Be(SingleClearExecutor.BlockerChangedReasonCode);
        verdict.Evidence.Should().Contain("expected_target=rock_target_1");
        verdict.Evidence.Should().Contain("actual_target=weed_target_9");
    }

    [Fact]
    public void ABlockerThatIsAlreadyGoneIsRefusedByName()
    {
        SingleClearExecutor executor = Executor();

        SingleClearAuthorization verdict = executor.AuthorizeSwing(InReach(present: false), nowMs: 1);

        verdict.Allowed.Should().BeFalse();
        verdict.ReasonCode.Should().Be(SingleClearExecutor.BlockerGoneReasonCode);
    }

    [Fact]
    public void AnApproachThatDidNotArriveStartsNoSwing()
    {
        // The walk can be interrupted; the reach is re-checked at the swing rather than assumed from the
        // plan that authorised the walk.
        SingleClearExecutor executor = Executor();

        SingleClearAuthorization verdict = executor.AuthorizeSwing(InReach(actorX: 48, actorY: 14, inToolReach: false), nowMs: 1);

        verdict.Allowed.Should().BeFalse();
        verdict.ReasonCode.Should().Be(SingleClearExecutor.OutOfReachReasonCode);
        verdict.Evidence.Should().Contain("distance=5");
    }
}
