using System;
using System.Collections.Generic;

namespace GameBuddy.Stardew.Sensory;

/// <summary>
/// Deterministic sensory event filter and deduplicator for salient events.
/// Enforces that only frozen milestones and DayStarted emit, deduplicates within loaded scope,
/// and stays quiet between milestones.
/// </summary>
public interface ISalientEventFilter
{
    /// <summary>
    /// Checks if a DayStarted event is salient and has not yet been emitted for this day in the current loaded scope.
    /// Deduplication key format: day_started_day_&lt;TotalDays&gt;
    /// </summary>
    bool IsDayStartedSalient(int totalDays, out string deduplicationKey, string? scope = null);

    /// <summary>
    /// Checks if a TimeChanged event is salient - 0600, 1200, 1800, 2200 or 2400, and only while the companion is awake
    /// - and has not yet been emitted for this day and milestone in the current loaded scope.
    /// <paramref name="companionInBed"/> is the companion's OWN bed state; no state of the host player is an input.
    /// Deduplication key format: time_milestone_day_&lt;TotalDays&gt;_&lt;HHmm&gt;
    /// </summary>
    bool IsTimeMilestoneSalient(int totalDays, int timeOfDay, bool companionInBed, out string deduplicationKey, out string formattedTime, string? scope = null);

    /// <summary>
    /// Convenience alias for IsDayStartedSalient.
    /// </summary>
    bool TryFilterDayStarted(int totalDays, out string deduplicationKey, string? scope = null);

    /// <summary>
    /// Convenience alias for IsTimeMilestoneSalient.
    /// </summary>
    bool TryFilterTimeMilestone(int totalDays, int timeOfDay, bool companionInBed, out string deduplicationKey, out string formattedTime, string? scope = null);

    /// <summary>
    /// Resets all recorded deduplication state (e.g. on world unload/reload).
    /// </summary>
    void Reset();
}

/// <summary>
/// Default thread-safe implementation of <see cref="ISalientEventFilter"/>.
/// </summary>
public sealed class SalientEventFilter : ISalientEventFilter
{
    /// <summary>
    /// The hours a person notices on their own: morning, noon, evening, ten, and midnight.
    ///
    /// <para>
    /// Midnight is here because the night does not end at 22:00. A companion who chose to stay up at ten heard NOTHING
    /// until the engine passed her out at 26:00 - 175 s of silence, run
    /// `.live-runs/game-ladder/2026-11-05T11-37-35-764Z-multiday_routine`, judged `companion_did_not_sleep` - so she was
    /// never given the fact that the night she was staying up in had moved on.
    /// </para>
    /// <para>
    /// 2600 is deliberately absent: the engine's own pass-out is published as `night_ended_pass_out` at exactly that
    /// threshold (`StardewSalientEventHooks.OnUpdateTicked`), so a milestone there would tell the same moment twice.
    /// </para>
    /// </summary>
    private static readonly HashSet<int> AllowedMilestones = new() { 600, 1200, 1800, 2200, 2400 };
    private readonly object syncLock = new();
    private readonly HashSet<(string Scope, string Key)> emittedEvents = new();

    public bool IsDayStartedSalient(int totalDays, out string deduplicationKey, string? scope = null)
    {
        if (totalDays < 0)
        {
            deduplicationKey = string.Empty;
            return false;
        }

        string key = $"day_started_day_{totalDays}";
        deduplicationKey = key;
        string resolvedScope = scope ?? string.Empty;

        lock (this.syncLock)
        {
            return this.emittedEvents.Add((resolvedScope, key));
        }
    }

    /// <summary>
    /// Whether this hour is a fact about the world the companion is actually in.
    ///
    /// <para>
    /// INVARIANT: a clock fact is emitted only while the companion is awake; being in bed is the reason to stay silent,
    /// not the hour. The hour alone cannot decide it - a companion who has already gone to bed must not be woken with
    /// news about a night she is not standing in, and one who is still up must hear that the night is advancing.
    /// </para>
    /// <para>
    /// `companionInBed` is HER bed state, never the host player's. In a shared save her sleeping does not cut the host's
    /// day, so the host lying down or still playing is not the question and must not silence her clock.
    /// </para>
    /// </summary>
    public bool IsTimeMilestoneSalient(int totalDays, int timeOfDay, bool companionInBed, out string deduplicationKey, out string formattedTime, string? scope = null)
    {
        if (totalDays < 0 || companionInBed || !AllowedMilestones.Contains(timeOfDay))
        {
            deduplicationKey = string.Empty;
            formattedTime = string.Empty;
            return false;
        }

        formattedTime = timeOfDay.ToString("D4");
        string key = $"time_milestone_day_{totalDays}_{formattedTime}";
        deduplicationKey = key;
        string resolvedScope = scope ?? string.Empty;

        lock (this.syncLock)
        {
            return this.emittedEvents.Add((resolvedScope, key));
        }
    }

    public bool TryFilterDayStarted(int totalDays, out string deduplicationKey, string? scope = null)
        => this.IsDayStartedSalient(totalDays, out deduplicationKey, scope);

    public bool TryFilterTimeMilestone(int totalDays, int timeOfDay, bool companionInBed, out string deduplicationKey, out string formattedTime, string? scope = null)
        => this.IsTimeMilestoneSalient(totalDays, timeOfDay, companionInBed, out deduplicationKey, out formattedTime, scope);

    public void Reset()
    {
        lock (this.syncLock)
        {
            this.emittedEvents.Clear();
        }
    }
}
