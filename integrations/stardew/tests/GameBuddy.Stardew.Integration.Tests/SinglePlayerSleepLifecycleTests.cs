using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The M2 cross-day lifecycle (<c>single_player_sleep_and_advance_day</c>) is a
/// coordinated lifecycle, not a wire action, so its live behavior belongs to the
/// native-local fixture lane. These assertions cover the surface that must fail
/// closed without a live game: the opt-in config gate and the constructor.
///
/// Live evidence (Stardew 1.6.15 / SMAPI 4.5.2, native-local fixture):
///   state=passed; reasonCode=day_advanced; dayBefore=0 -> dayAfter=1;
///   savingObserved/savedObserved/dayStartedObserved=true.
/// </summary>
public sealed class SinglePlayerSleepLifecycleTests
{
    private static string EvidencePath => Path.Combine(Path.GetTempPath(), "gamebuddy-sleep-lifecycle-test.json");

    private static SinglePlayerSleepLifecycleConfig ValidConfig => new()
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
        var config = new SinglePlayerSleepLifecycleConfig
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
        var config = new SinglePlayerSleepLifecycleConfig
        {
            Enable = true,
            EvidencePath = evidencePath,
        };

        config.IsValid.Should().BeFalse();
    }

    [Theory]
    [InlineData(9)]
    [InlineData(601)]
    public void OutOfRangeTimeout_IsRejected(int timeoutSeconds)
    {
        var config = new SinglePlayerSleepLifecycleConfig
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
        var config = new SinglePlayerSleepLifecycleConfig
        {
            Enable = true,
            EvidencePath = EvidencePath,
            SettleFrameBudget = settleFrameBudget,
        };

        config.IsValid.Should().BeFalse();
    }

    [Fact]
    public void TryStart_WithNullConfig_ReturnsNullAndStartsNothing()
    {
        SinglePlayerSleepLifecycle.TryStart(new DummyMonitor(), null).Should().BeNull();
    }

    [Fact]
    public void TryStart_WithInvalidConfig_ReturnsNullAndStartsNothing()
    {
        var config = new SinglePlayerSleepLifecycleConfig
        {
            Enable = true,
            EvidencePath = "relative/evidence.json",
        };

        SinglePlayerSleepLifecycle.TryStart(new DummyMonitor(), config).Should().BeNull();
    }

    [Fact]
    public void TryStart_WithValidConfig_StartsTheLifecycle()
    {
        SinglePlayerSleepLifecycle.TryStart(new DummyMonitor(), ValidConfig).Should().NotBeNull();
    }
}
