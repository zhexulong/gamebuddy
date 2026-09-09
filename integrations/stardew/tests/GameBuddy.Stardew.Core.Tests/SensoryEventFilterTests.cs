using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Sensory;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public class SensoryEventFilterTests
{
    [Fact]
    public void SalienceThreshold_OnlyDayStartedAndMilestonesAreSalient()
    {
        var filter = new SalientEventFilter();

        // DayStarted is salient
        filter.IsDayStartedSalient(totalDays: 1, out string dayKey).Should().BeTrue();
        dayKey.Should().Be("day_started_day_1");

        // Allowed milestones (0600, 1200, 1800, 2200) are salient
        int[] milestones = { 600, 1200, 1800, 2200 };
        foreach (int milestone in milestones)
        {
            filter.IsTimeMilestoneSalient(totalDays: 1, milestone, out string key, out string formattedTime).Should().BeTrue();
            key.Should().Be($"time_milestone_day_1_{milestone:D4}");
            formattedTime.Should().Be($"{milestone:D4}");
        }

        // Non-milestones are NOT salient
        int[] nonMilestones = { 0, 100, 610, 620, 700, 800, 930, 1100, 1150, 1210, 1300, 1750, 1810, 1900, 2150, 2210, 2300, 2400, 2500, 2600 };
        foreach (int nonMilestone in nonMilestones)
        {
            filter.IsTimeMilestoneSalient(totalDays: 1, nonMilestone, out string key, out string formattedTime).Should().BeFalse();
            key.Should().BeEmpty();
            formattedTime.Should().BeEmpty();
        }

        // Negative totalDays is invalid and rejected
        filter.IsDayStartedSalient(totalDays: -1, out _).Should().BeFalse();
        filter.IsTimeMilestoneSalient(totalDays: -1, 600, out _, out _).Should().BeFalse();
    }

    [Fact]
    public void MilestoneFormatting_ProducesCorrectKeysAndFormat()
    {
        var filter = new SalientEventFilter();

        filter.IsDayStartedSalient(1, out string day1Key).Should().BeTrue();
        day1Key.Should().Be("day_started_day_1");

        filter.IsDayStartedSalient(100, out string day100Key).Should().BeTrue();
        day100Key.Should().Be("day_started_day_100");

        filter.IsTimeMilestoneSalient(5, 600, out string m600, out string t600).Should().BeTrue();
        m600.Should().Be("time_milestone_day_5_0600");
        t600.Should().Be("0600");

        filter.IsTimeMilestoneSalient(5, 1200, out string m1200, out string t1200).Should().BeTrue();
        m1200.Should().Be("time_milestone_day_5_1200");
        t1200.Should().Be("1200");

        filter.IsTimeMilestoneSalient(5, 1800, out string m1800, out string t1800).Should().BeTrue();
        m1800.Should().Be("time_milestone_day_5_1800");
        t1800.Should().Be("1800");

        filter.IsTimeMilestoneSalient(5, 2200, out string m2200, out string t2200).Should().BeTrue();
        m2200.Should().Be("time_milestone_day_5_2200");
        t2200.Should().Be("2200");
    }

    [Fact]
    public void Deduplication_DayStartedEmitsOncePerDay()
    {
        var filter = new SalientEventFilter();

        // Day 1
        filter.IsDayStartedSalient(1, out string key1).Should().BeTrue();
        key1.Should().Be("day_started_day_1");

        // Duplicate DayStarted on Day 1 is suppressed
        filter.IsDayStartedSalient(1, out string dupKey1).Should().BeFalse();
        dupKey1.Should().Be("day_started_day_1");

        filter.IsDayStartedSalient(1, out _).Should().BeFalse();

        // Day 2 emits
        filter.IsDayStartedSalient(2, out string key2).Should().BeTrue();
        key2.Should().Be("day_started_day_2");

        // Duplicate DayStarted on Day 2 is suppressed
        filter.IsDayStartedSalient(2, out _).Should().BeFalse();
    }

    [Fact]
    public void Deduplication_MilestoneEmitsOncePerDayAndMilestone()
    {
        var filter = new SalientEventFilter();

        // Day 1: 0600 emits once
        filter.IsTimeMilestoneSalient(1, 600, out string k1, out _).Should().BeTrue();
        k1.Should().Be("time_milestone_day_1_0600");
        filter.IsTimeMilestoneSalient(1, 600, out _, out _).Should().BeFalse();

        // Day 1: 1200 emits once
        filter.IsTimeMilestoneSalient(1, 1200, out string k2, out _).Should().BeTrue();
        k2.Should().Be("time_milestone_day_1_1200");
        filter.IsTimeMilestoneSalient(1, 1200, out _, out _).Should().BeFalse();

        // Day 1: 1800 emits once
        filter.IsTimeMilestoneSalient(1, 1800, out string k3, out _).Should().BeTrue();
        k3.Should().Be("time_milestone_day_1_1800");
        filter.IsTimeMilestoneSalient(1, 1800, out _, out _).Should().BeFalse();

        // Day 1: 2200 emits once
        filter.IsTimeMilestoneSalient(1, 2200, out string k4, out _).Should().BeTrue();
        k4.Should().Be("time_milestone_day_1_2200");
        filter.IsTimeMilestoneSalient(1, 2200, out _, out _).Should().BeFalse();

        // Day 2: all four milestones emit once again
        filter.IsTimeMilestoneSalient(2, 600, out string k2_1, out _).Should().BeTrue();
        k2_1.Should().Be("time_milestone_day_2_0600");
        filter.IsTimeMilestoneSalient(2, 600, out _, out _).Should().BeFalse();

        filter.IsTimeMilestoneSalient(2, 1200, out string k2_2, out _).Should().BeTrue();
        k2_2.Should().Be("time_milestone_day_2_1200");
        filter.IsTimeMilestoneSalient(2, 1200, out _, out _).Should().BeFalse();

        filter.IsTimeMilestoneSalient(2, 1800, out string k2_3, out _).Should().BeTrue();
        k2_3.Should().Be("time_milestone_day_2_1800");
        filter.IsTimeMilestoneSalient(2, 1800, out _, out _).Should().BeFalse();

        filter.IsTimeMilestoneSalient(2, 2200, out string k2_4, out _).Should().BeTrue();
        k2_4.Should().Be("time_milestone_day_2_2200");
        filter.IsTimeMilestoneSalient(2, 2200, out _, out _).Should().BeFalse();
    }

    [Fact]
    public void QuietPeriod_BetweenMilestonesNoEventsEmitted()
    {
        var filter = new SalientEventFilter();

        // 06:00 emits
        filter.IsTimeMilestoneSalient(1, 600, out _, out _).Should().BeTrue();

        // Quiet period: 06:10 to 11:50
        for (int t = 610; t < 1200; t += 10)
        {
            if (t % 100 >= 60) continue; // skip invalid minute values in Stardew time
            filter.IsTimeMilestoneSalient(1, t, out _, out _).Should().BeFalse(
                $"Time {t} should be in quiet period and not emit");
        }

        // 12:00 emits
        filter.IsTimeMilestoneSalient(1, 1200, out _, out _).Should().BeTrue();

        // Quiet period: 12:10 to 17:50
        for (int t = 1210; t < 1800; t += 10)
        {
            if (t % 100 >= 60) continue;
            filter.IsTimeMilestoneSalient(1, t, out _, out _).Should().BeFalse(
                $"Time {t} should be in quiet period and not emit");
        }

        // 18:00 emits
        filter.IsTimeMilestoneSalient(1, 1800, out _, out _).Should().BeTrue();

        // Quiet period: 18:10 to 21:50
        for (int t = 1810; t < 2200; t += 10)
        {
            if (t % 100 >= 60) continue;
            filter.IsTimeMilestoneSalient(1, t, out _, out _).Should().BeFalse(
                $"Time {t} should be in quiet period and not emit");
        }

        // 22:00 emits
        filter.IsTimeMilestoneSalient(1, 2200, out _, out _).Should().BeTrue();

        // Quiet period: 22:10 to 26:00
        for (int t = 2210; t <= 2600; t += 10)
        {
            if (t % 100 >= 60) continue;
            filter.IsTimeMilestoneSalient(1, t, out _, out _).Should().BeFalse(
                $"Time {t} should be in quiet period and not emit");
        }
    }

    [Fact]
    public void Reset_ClearsDeduplicationHistory()
    {
        var filter = new SalientEventFilter();

        // Emit on Day 1
        filter.IsDayStartedSalient(1, out _).Should().BeTrue();
        filter.IsTimeMilestoneSalient(1, 600, out _, out _).Should().BeTrue();

        // Deduplication blocks repeat
        filter.IsDayStartedSalient(1, out _).Should().BeFalse();
        filter.IsTimeMilestoneSalient(1, 600, out _, out _).Should().BeFalse();

        // Reset (e.g. world unload/reload)
        filter.Reset();

        // Now both can emit again
        filter.IsDayStartedSalient(1, out _).Should().BeTrue();
        filter.IsTimeMilestoneSalient(1, 600, out _, out _).Should().BeTrue();
    }

    [Fact]
    public void ScopeIsolation_DeduplicationIsScoped()
    {
        var filter = new SalientEventFilter();

        // Scope A emits
        filter.IsDayStartedSalient(1, out _, scope: "save_A").Should().BeTrue();
        filter.IsTimeMilestoneSalient(1, 600, out _, out _, scope: "save_A").Should().BeTrue();

        // Scope B emits independently for the same day and milestone
        filter.IsDayStartedSalient(1, out _, scope: "save_B").Should().BeTrue();
        filter.IsTimeMilestoneSalient(1, 600, out _, out _, scope: "save_B").Should().BeTrue();

        // Repeats within Scope A are blocked
        filter.IsDayStartedSalient(1, out _, scope: "save_A").Should().BeFalse();
        filter.IsTimeMilestoneSalient(1, 600, out _, out _, scope: "save_A").Should().BeFalse();

        // Repeats within Scope B are blocked
        filter.IsDayStartedSalient(1, out _, scope: "save_B").Should().BeFalse();
        filter.IsTimeMilestoneSalient(1, 600, out _, out _, scope: "save_B").Should().BeFalse();
    }

    [Fact]
    public void ConvenienceAliases_DelegateCorrectly()
    {
        var filter = new SalientEventFilter();

        filter.TryFilterDayStarted(1, out string dayKey).Should().BeTrue();
        dayKey.Should().Be("day_started_day_1");
        filter.TryFilterDayStarted(1, out _).Should().BeFalse();

        filter.TryFilterTimeMilestone(1, 1200, out string timeKey, out string formattedTime).Should().BeTrue();
        timeKey.Should().Be("time_milestone_day_1_1200");
        formattedTime.Should().Be("1200");
        filter.TryFilterTimeMilestone(1, 1200, out _, out _).Should().BeFalse();
    }

    [Fact]
    public void BridgeWorldFact_DayStartedAndMilestonePayloads_SerializeAndDeserialize()
    {
        // DayStarted fact
        var dayFact = new BridgeWorldFact(
            "day_started_day_1",
            "day_started_day_1",
            "day_started",
            120,
            "0600",
            1,
            "{\"day\":1}",
            "day_started_day_1");

        var dayEnvelope = new BridgeEnvelope<BridgeWorldFact>(
            BridgeProtocol.Version,
            "msg_fact_day_01",
            "corr_fact_day_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            "world_fact",
            dayFact);

        BridgeProtocol.TrySerialize(dayEnvelope, out string dayJson, out string serializeReason)
            .Should().BeTrue(serializeReason);
        dayJson.Should().Contain("\"kind\":\"day_started\"");
        dayJson.Should().Contain("\"deduplicationKey\":\"day_started_day_1\"");

        BridgeProtocol.TryDeserializeWorldFact(dayJson, out var deserializedDay, out string deserializeReason)
            .Should().BeTrue(deserializeReason);
        deserializedDay.Should().NotBeNull();
        deserializedDay!.Payload.EventId.Should().Be("day_started_day_1");
        deserializedDay.Payload.Kind.Should().Be("day_started");
        deserializedDay.Payload.DeduplicationKey.Should().Be("day_started_day_1");

        // TimeMilestone fact
        var timeFact = new BridgeWorldFact(
            "time_milestone_day_1_1200",
            "time_milestone_day_1_1200",
            "time_milestone",
            240,
            "1200",
            1,
            "{\"milestone\":\"1200\"}",
            "time_milestone_day_1_1200");

        var timeEnvelope = new BridgeEnvelope<BridgeWorldFact>(
            BridgeProtocol.Version,
            "msg_fact_time_01",
            "corr_fact_time_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            "world_fact",
            timeFact);

        BridgeProtocol.TrySerialize(timeEnvelope, out string timeJson, out string timeSerializeReason)
            .Should().BeTrue(timeSerializeReason);
        timeJson.Should().Contain("\"kind\":\"time_milestone\"");
        timeJson.Should().Contain("\"gameTime\":\"1200\"");
        timeJson.Should().Contain("\"deduplicationKey\":\"time_milestone_day_1_1200\"");

        BridgeProtocol.TryDeserializeWorldFact(timeJson, out var deserializedTime, out string timeDeserializeReason)
            .Should().BeTrue(timeDeserializeReason);
        deserializedTime.Should().NotBeNull();
        deserializedTime!.Payload.EventId.Should().Be("time_milestone_day_1_1200");
        deserializedTime.Payload.Kind.Should().Be("time_milestone");
        deserializedTime.Payload.GameTime.Should().Be("1200");
        deserializedTime.Payload.DeduplicationKey.Should().Be("time_milestone_day_1_1200");
    }
}
