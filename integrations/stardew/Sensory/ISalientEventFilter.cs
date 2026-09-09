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
    /// Checks if a TimeChanged event is salient (0600, 1200, 1800, 2200) and has not yet been emitted for this day and milestone in the current loaded scope.
    /// Deduplication key format: time_milestone_day_&lt;TotalDays&gt;_&lt;HHmm&gt;
    /// </summary>
    bool IsTimeMilestoneSalient(int totalDays, int timeOfDay, out string deduplicationKey, out string formattedTime, string? scope = null);

    /// <summary>
    /// Convenience alias for IsDayStartedSalient.
    /// </summary>
    bool TryFilterDayStarted(int totalDays, out string deduplicationKey, string? scope = null);

    /// <summary>
    /// Convenience alias for IsTimeMilestoneSalient.
    /// </summary>
    bool TryFilterTimeMilestone(int totalDays, int timeOfDay, out string deduplicationKey, out string formattedTime, string? scope = null);

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
    private static readonly HashSet<int> AllowedMilestones = new() { 600, 1200, 1800, 2200 };
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

    public bool IsTimeMilestoneSalient(int totalDays, int timeOfDay, out string deduplicationKey, out string formattedTime, string? scope = null)
    {
        if (totalDays < 0 || !AllowedMilestones.Contains(timeOfDay))
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

    public bool TryFilterTimeMilestone(int totalDays, int timeOfDay, out string deduplicationKey, out string formattedTime, string? scope = null)
        => this.IsTimeMilestoneSalient(totalDays, timeOfDay, out deduplicationKey, out formattedTime, scope);

    public void Reset()
    {
        lock (this.syncLock)
        {
            this.emittedEvents.Clear();
        }
    }
}
