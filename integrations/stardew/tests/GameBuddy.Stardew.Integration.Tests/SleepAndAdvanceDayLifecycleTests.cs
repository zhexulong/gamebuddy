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

    [Theory]
    [InlineData("")]
    [InlineData("relative/evidence.json")]
    public void NonAbsoluteEvidencePath_IsRejected(string evidencePath)
    {
        var config = new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = evidencePath,
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
}
