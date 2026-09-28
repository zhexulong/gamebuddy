using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The cross-day lifecycle (<c>single_player_sleep_and_advance_day</c> plus the
/// multiplayer ready-barrier variants) is a coordinated lifecycle, not a wire
/// action, so its live behavior belongs to the fixture lane. These assertions
/// cover the surface that must fail closed without a live game: the opt-in config
/// gate and the constructor.
///
/// Live evidence (Stardew 1.6.15 / SMAPI 4.5.2, native-local fixture):
///   single player: state=passed; reasonCode=day_advanced; dayBefore=0 ->
///   dayAfter=1; savingObserved/savedObserved/dayStartedObserved=true.
/// </summary>
public sealed class SleepAndAdvanceDayLifecycleTests
{
    private static string EvidencePath => Path.Combine(Path.GetTempPath(), "gamebuddy-sleep-lifecycle-test.json");

    private static SleepAndAdvanceDayLifecycleConfig ValidConfig => new()
    {
        Enable = true,
        EvidencePath = EvidencePath,
    };

    [Fact]
    public void ValidConfig_IsAccepted()
    {
        ValidConfig.IsValid.Should().BeTrue();
    }

    [Fact]
    public void DisabledConfig_IsRejected()
    {
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = false,
            EvidencePath = EvidencePath,
        };

        config.IsValid.Should().BeFalse();
    }

    [Fact]
    public void EmptyEvidencePath_IsAcceptedForAnExecutionOwnedNight()
    {
        // An execution-owned night (the wire `advance_day` action) has no file to
        // write: the bridge receipt carries the same facts, and the ledger mints
        // it. Requiring a path here would reject every such night.
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = string.Empty,
        };

        config.IsValid.Should().BeTrue();
    }

    [Fact]
    public void NonAbsoluteEvidencePath_IsRejected()
    {
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = "relative/evidence.json",
        };

        config.IsValid.Should().BeFalse();
    }

    [Theory]
    [InlineData(9)]
    [InlineData(3601)]
    public void OutOfRangeTimeout_IsRejected(int timeoutSeconds)
    {
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = EvidencePath,
            TimeoutSeconds = timeoutSeconds,
        };

        config.IsValid.Should().BeFalse();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(601)]
    public void OutOfRangeSettleFrameBudget_IsRejected(int settleFrameBudget)
    {
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = EvidencePath,
            SettleFrameBudget = settleFrameBudget,
        };

        config.IsValid.Should().BeFalse();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(36001)]
    public void OutOfRangeReadyBarrierBudget_IsRejected(int readyBarrierFrameBudget)
    {
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = EvidencePath,
            ReadyBarrierFrameBudget = readyBarrierFrameBudget,
        };

        config.IsValid.Should().BeFalse();
    }

    [Fact]
    public void MultiplayerReadyBarrierBudget_IsAcceptedWithinRange()
    {
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = EvidencePath,
            // A shared-world barrier may legitimately wait far longer than an
            // animation, so the budget must accept large frame counts.
            ReadyBarrierFrameBudget = 36000,
            TimeoutSeconds = 3600,
        };

        config.IsValid.Should().BeTrue();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(9)]
    public void OutOfRangeMinimumOnlineFarmers_IsRejected(int minimumOnlineFarmers)
    {
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = EvidencePath,
            MinimumOnlineFarmers = minimumOnlineFarmers,
        };

        config.IsValid.Should().BeFalse();
    }

    [Fact]
    public void TryStart_WithNullConfig_ReturnsNullAndStartsNothing()
    {
        SleepAndAdvanceDayLifecycle.TryStart(new DummyMonitor(), null).Should().BeNull();
    }

    [Fact]
    public void TryStart_WithInvalidConfig_ReturnsNullAndStartsNothing()
    {
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = "relative/evidence.json",
        };

        SleepAndAdvanceDayLifecycle.TryStart(new DummyMonitor(), config).Should().BeNull();
    }

    [Fact]
    public void TryStart_WithValidConfig_StartsTheLifecycle()
    {
        SleepAndAdvanceDayLifecycle.TryStart(new DummyMonitor(), ValidConfig).Should().NotBeNull();
    }

    // --- Pass-out hazard predicate --------------------------------------------
    //
    // Pass-out is an automatic native gate (Game1.cs:6452: `timeOfDay >= 2600 ||
    // stamina <= -15f` -> `player.startToPassOut()`), not something this lifecycle
    // may start. It must YIELD to it instead of competing for the same actor: the
    // path finder this lifecycle installs would otherwise keep issuing moves while
    // Farmer.performPassOut() runs `completelyStopAnimatingOrDoingAction()` +
    // `animateOnce(293)` (Farmer.cs:5766-5782).

    [Fact]
    public void PassOutPredicate_IsFalseWhenTheActorIsHealthy()
    {
        SleepAndAdvanceDayLifecycle.IsPassOutHazard(
            passedOut: false,
            spritePassingOut: false,
            nonCancelableBarrier: false).Should().BeFalse();
    }

    [Fact]
    public void PassOutPredicate_IsTrueWhenTheNativePipelineOwnsTheActor()
    {
        SleepAndAdvanceDayLifecycle.IsPassOutHazard(
            passedOut: true,
            spritePassingOut: false,
            nonCancelableBarrier: false).Should().BeTrue();
    }

    [Fact]
    public void PassOutPredicate_IsTrueWhileTheNativeAnimationIsRunning()
    {
        // This is the case that the earlier implementation missed: the animation
        // can be running before `passedOut` flips, and continuing to drive the
        // controller there is exactly the interference this predicate prevents.
        SleepAndAdvanceDayLifecycle.IsPassOutHazard(
            passedOut: false,
            spritePassingOut: true,
            nonCancelableBarrier: false).Should().BeTrue();
    }

    [Fact]
    public void PassOutPredicate_IsTrueForTheNonCancelableSharedWorldBarrier()
    {
        // PassOutNewDay() installs `ReadyCheckDialog("sleep", allowCancel: false)`
        // in a shared world (Game1.cs:10357-10360), which is a different ingress
        // from a normal bedtime ready check (that one is cancelable).
        SleepAndAdvanceDayLifecycle.IsPassOutHazard(
            passedOut: false,
            spritePassingOut: false,
            nonCancelableBarrier: true).Should().BeTrue();
    }

    [Fact]
    public void ValidConfig_AcceptsAMultiplayerMinimumOfTwoFarmers()
    {
        // A co-op night must not be advanced alone, so the driver declares 2.
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = EvidencePath,
            MinimumOnlineFarmers = 2,
        };

        config.IsValid.Should().BeTrue();
    }

    // --- Day-start decision ----------------------------------------------------
    //
    // The date counter is NOT the day start. On the master it advances while
    // NewDay's save is still in flight; on a client it syncs over the network.
    // Measured live in co-op: the client saw delta==1 at the same moment the
    // master logged "before save", so a receipt built on the counter alone could
    // report success while the game was still writing to disk and the Agent could
    // dispatch the next action mid-save.

    [Fact]
    public void DayStartDecision_WaitsOnTheCounterAloneEvenWhenItHasAdvanced()
    {
        SleepAndAdvanceDayLifecycle.DecideDayStart(
            delta: 1,
            dayStartedObserved: false,
            dayStartWaitFrames: 0,
            budget: 3600).Should().Be(SleepAndAdvanceDayLifecycle.DayStartOutcome.Waiting);
    }

    [Fact]
    public void DayStartDecision_ConfirmsOnlyOnceTheNewDayActuallyBegan()
    {
        SleepAndAdvanceDayLifecycle.DecideDayStart(
            delta: 1,
            dayStartedObserved: true,
            dayStartWaitFrames: 0,
            budget: 3600).Should().Be(SleepAndAdvanceDayLifecycle.DayStartOutcome.Confirmed);
    }

    [Fact]
    public void DayStartDecision_ReportsHonestlyWhenTheNewDayNeverBegan()
    {
        // Reporting day_advanced here would forge a success the game never
        // reached, so the terminal must be day_start_not_observed instead.
        SleepAndAdvanceDayLifecycle.DecideDayStart(
            delta: 1,
            dayStartedObserved: false,
            dayStartWaitFrames: 3600,
            budget: 3600).Should().Be(SleepAndAdvanceDayLifecycle.DayStartOutcome.NotObserved);
    }

    [Fact]
    public void DayStartDecision_WaitsWhileTheDayHasNotRolled()
    {
        SleepAndAdvanceDayLifecycle.DecideDayStart(
            delta: 0,
            dayStartedObserved: false,
            dayStartWaitFrames: 0,
            budget: 3600).Should().Be(SleepAndAdvanceDayLifecycle.DayStartOutcome.Waiting);
    }

    [Fact]
    public void DayStartDecision_RejectsASecondRollover()
    {
        // A +2 jump means two rollovers ran under one bounded lifecycle.
        SleepAndAdvanceDayLifecycle.DecideDayStart(
            delta: 2,
            dayStartedObserved: true,
            dayStartWaitFrames: 0,
            budget: 3600).Should().Be(SleepAndAdvanceDayLifecycle.DayStartOutcome.UnexpectedDelta);
    }

    // --- Fresh event edge ------------------------------------------------------
    //
    // SMAPI raises DayStarted "including when the player loads a save", so the
    // load-time edge already happened before the night is slept. The counter is
    // therefore only meaningful relative to a baseline, and these tests pin the
    // comparison itself: a sticky boolean (or a count compared against zero rather
    // than the baseline) would let the load-time edge satisfy the gate.

    [Fact]
    public void FreshEdge_IsFalseWhenTheBaselineWasNeverCaptured()
    {
        // Before the night begins there is no baseline, so no edge may count.
        SleepAndAdvanceDayLifecycle.HasFreshEdge(
            count: 1,
            baseline: 0,
            baselineCaptured: false).Should().BeFalse();
    }

    [Fact]
    public void FreshEdge_IsFalseForTheLoadTimeEdgeThatAlreadyFired()
    {
        // This is the exact live failure: one DayStarted fired at load, the
        // baseline was captured at 1, and the count is still 1. The night's new day
        // has NOT begun, so the gate must stay closed.
        SleepAndAdvanceDayLifecycle.HasFreshEdge(
            count: 1,
            baseline: 1,
            baselineCaptured: true).Should().BeFalse();
    }

    [Fact]
    public void FreshEdge_IsTrueOnlyAfterAnEdgeFiresPastTheBaseline()
    {
        // The night's own DayStarted: the baseline was 1 and the count is now 2.
        SleepAndAdvanceDayLifecycle.HasFreshEdge(
            count: 2,
            baseline: 1,
            baselineCaptured: true).Should().BeTrue();
    }
}
