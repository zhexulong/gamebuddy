using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The frozen 120-tick bound on the per-frame action-policy reload: an edit to
/// `config.json` must reach the capability surface within 2 seconds at 60 Hz,
/// so the reload runs at 0.5 Hz instead of every frame. These tests pin the
/// latency and the first-tick admission.
/// </summary>
public sealed class FarmhandPolicyRefreshThrottleTests
{
    [Fact]
    public void FirstTickIsAdmittedSoAFreshEmbodimentPublishesImmediately()
    {
        var throttle = new FarmhandPolicyRefreshThrottle();

        throttle.ShouldRefresh(0).Should().BeTrue("a just-mounted embodiment publishes on its first tick");
    }

    [Fact]
    public void AdmittedRefreshIsTheLastTickInsideTheFrozenInterval()
    {
        var throttle = new FarmhandPolicyRefreshThrottle();

        throttle.ShouldRefresh(100).Should().BeTrue();
        throttle.ShouldRefresh(100 + FarmhandPolicyRefreshThrottle.RefreshIntervalTicks - 1).Should().BeFalse(
            "the interval is exclusive at its lower bound");
        throttle.ShouldRefresh(100 + FarmhandPolicyRefreshThrottle.RefreshIntervalTicks).Should().BeTrue(
            "an edit must land within the frozen 120-tick bound");
    }

    [Fact]
    public void ReloadRunsAtTheFrozenCadenceAcrossAMinuteOfTicks()
    {
        var throttle = new FarmhandPolicyRefreshThrottle();
        int admissions = 0;

        // 60 Hz for one minute; 2 s == 120 ticks, so 60 seconds admits 30
        // reloads (tick 0 plus one every 120 ticks), not 3600.
        for (long tick = 0; tick < 60 * 60; tick++)
        {
            if (throttle.ShouldRefresh((uint)tick))
                admissions++;
        }

        admissions.Should().Be(30);
    }

    [Fact]
    public void ThrottleCountsTicksNotWallClockSoAPausedWorldDoesNotExpireTheInterval()
    {
        var throttle = new FarmhandPolicyRefreshThrottle();

        throttle.ShouldRefresh(500).Should().BeTrue();
        // The world paused for an hour of wall clock but only 3 ticks ran; the
        // reload must still be gated, because the config read it guards is
        // equally cheap to redo and the bound is expressed in ticks.
        throttle.ShouldRefresh(503).Should().BeFalse();
        throttle.ShouldRefresh(500 + FarmhandPolicyRefreshThrottle.RefreshIntervalTicks).Should().BeTrue();
    }

    [Fact]
    public void TheFrozenIntervalIsTwoSecondsAtSixtyHertz()
    {
        FarmhandPolicyRefreshThrottle.RefreshIntervalTicks.Should().Be(120);
    }
}
