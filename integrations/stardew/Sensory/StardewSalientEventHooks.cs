using System;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace GameBuddy.Stardew.Sensory;

/// <summary>
/// Subscribes to native SMAPI game loop events (DayStarted, TimeChanged) on the game thread,
/// checks salience via <see cref="ISalientEventFilter"/>, constructs typed <see cref="BridgeWorldFact"/> records,
/// and emits them via <see cref="BridgeSession.TryCreateWorldFactEvent"/>.
/// </summary>
internal sealed class StardewSalientEventHooks : IDisposable
{
    private readonly IModEvents events;
    private readonly ISalientEventFilter filter;
    private readonly Func<BridgeSession?> sessionProvider;
    private readonly Func<BridgeScope?>? scopeProvider;
    private readonly IMonitor? monitor;

    internal StardewSalientEventHooks(
        IModEvents events,
        ISalientEventFilter filter,
        Func<BridgeSession?> sessionProvider,
        Func<BridgeScope?>? scopeProvider = null,
        IMonitor? monitor = null)
    {
        this.events = events ?? throw new ArgumentNullException(nameof(events));
        this.filter = filter ?? throw new ArgumentNullException(nameof(filter));
        this.sessionProvider = sessionProvider ?? throw new ArgumentNullException(nameof(sessionProvider));
        this.scopeProvider = scopeProvider;
        this.monitor = monitor;

        this.events.GameLoop.DayStarted += this.OnDayStarted;
        this.events.GameLoop.TimeChanged += this.OnTimeChanged;
    }

    /// <summary>
    /// True once this pass-out has been published, so the fact fires once per night rather than once per tick.
    ///
    /// <para>
    /// The engine's pass-out is not an event: `Farmers.cs:3408` checks `timeOfDay >= 2600` and calls
    /// `Game1.PassOutNewDay()`, and `NewDay` resets `player.passedOut = false` (`Game1.cs:7880`) BEFORE `DayStarted` runs.
    /// So reading `passedOut` in the day-started hook always sees false, and a night the engine took was indistinguishable
    /// from a night the companion slept - measured 2026-10-31 (`round17`): two nights crossed, neither recorded, and the
    /// harness certified the run while the second was a 02:00 pass-out.
    /// </para>
    /// </summary>
    private bool passOutPublished;

    /// <summary>
    /// Publishes `night_ended_pass_out` when the clock reaches the engine's pass-out threshold.
    ///
    /// <para>
    /// `timeOfDay >= 2600` is the engine's own condition (`Farmer.cs:3408`) and nothing else in the day reaches it, so this
    /// observes the decision rather than guessing from a location warp afterwards. It runs before `NewDay`, which is the
    /// only window in which the fact is still knowable.
    /// </para>
    /// </summary>
    public void OnUpdateTicked(int totalDays, int timeOfDay, long observedTick, string gameTime)
    {
        if (timeOfDay < PassOutThreshold) {
            this.passOutPublished = false;
            return;
        }
        if (this.passOutPublished)
            return;
        this.passOutPublished = true;
        this.TryEmitNightEndedPassOut(totalDays, observedTick, gameTime);
    }

    /// <summary>The engine's own pass-out threshold (`Farmer.cs:3408`: `timeOfDay >= 2600`).</summary>
    public const int PassOutThreshold = 2600;

    /// <summary>Publishes the one fact that says how this night ended. Returns false when there is no session to publish to.</summary>
    public bool TryEmitNightEndedPassOut(int totalDays, long observedTick, string gameTime)
    {
        BridgeSession? session = this.sessionProvider();
        if (session is null)
        {
            this.monitor?.Log("GameBuddy salient event NightEndedPassOut skipped: bridge session unavailable.", LogLevel.Trace);
            return false;
        }

        string? scopeId = this.scopeProvider?.Invoke()?.SaveId ?? session.Scope?.SaveId;
        string eventId = $"night_ended_pass_out_day_{totalDays}";
        // The day the pass-out ENDED, not the new one: the actor collapsed on `totalDays` and wakes on `totalDays + 1`.
        string payloadJson = $"{{\"day\":{totalDays},\"timeOfDay\":{timeOfDayForPayload(gameTime)}}}";

        var fact = new BridgeWorldFact(
            eventId,
            eventId,
            "night_ended_pass_out",
            observedTick,
            gameTime,
            session.CurrentRevision,
            payloadJson,
            eventId);

        if (!session.TryCreateWorldFactEvent(fact))
        {
            this.monitor?.Log($"GameBuddy salient event NightEndedPassOut delivery unavailable: eventId={eventId}.", LogLevel.Trace);
            return false;
        }

        return true;
    }

    private static int timeOfDayForPayload(string gameTime) =>
        int.TryParse(gameTime, out int parsed) ? parsed : 0;

    public void OnDayStarted(object? sender, DayStartedEventArgs e)
    {
        int totalDays = Game1.Date?.TotalDays ?? 1;
        long observedTick = Game1.ticks;
        string gameTime = (Game1.timeOfDay >= 0 ? Game1.timeOfDay : 600).ToString("D4");
        this.TryEmitDayStarted(totalDays, observedTick, gameTime);
    }

    public void OnTimeChanged(object? sender, TimeChangedEventArgs e)
    {
        int totalDays = Game1.Date?.TotalDays ?? 1;
        long observedTick = Game1.ticks;
        this.TryEmitTimeMilestone(totalDays, e.NewTime, observedTick);
    }

    public bool TryEmitDayStarted(int totalDays, long observedTick, string gameTime = "0600")
    {
        BridgeSession? session = this.sessionProvider();
        if (session is null)
        {
            this.monitor?.Log("GameBuddy salient event DayStarted skipped: bridge session unavailable.", LogLevel.Trace);
            return false;
        }

        string? scopeId = this.scopeProvider?.Invoke()?.SaveId ?? session.Scope?.SaveId;
        if (!this.filter.IsDayStartedSalient(totalDays, out string eventId, scopeId))
            return false;

        string payloadJson = $"{{\"day\":{totalDays}}}";
        int revision = session.CurrentRevision;

        var fact = new BridgeWorldFact(
            eventId,
            eventId,
            "day_started",
            observedTick,
            gameTime,
            revision,
            payloadJson,
            eventId);

        if (!session.TryCreateWorldFactEvent(fact))
        {
            this.monitor?.Log($"GameBuddy salient event delivery unavailable: eventId={eventId}.", LogLevel.Trace);
            return false;
        }

        return true;
    }

    public bool TryEmitTimeMilestone(int totalDays, int timeOfDay, long observedTick)
    {
        BridgeSession? session = this.sessionProvider();
        if (session is null)
        {
            this.monitor?.Log("GameBuddy salient event TimeMilestone skipped: bridge session unavailable.", LogLevel.Trace);
            return false;
        }

        string? scopeId = this.scopeProvider?.Invoke()?.SaveId ?? session.Scope?.SaveId;
        if (!this.filter.IsTimeMilestoneSalient(totalDays, timeOfDay, out string eventId, out string formattedTime, scopeId))
            return false;

        string payloadJson = $"{{\"milestone\":\"{formattedTime}\"}}";
        int revision = session.CurrentRevision;

        var fact = new BridgeWorldFact(
            eventId,
            eventId,
            "time_milestone",
            observedTick,
            formattedTime,
            revision,
            payloadJson,
            eventId);

        if (!session.TryCreateWorldFactEvent(fact))
        {
            this.monitor?.Log($"GameBuddy salient event delivery unavailable: eventId={eventId}.", LogLevel.Trace);
            return false;
        }

        return true;
    }

    public void Dispose()
    {
        this.events.GameLoop.DayStarted -= this.OnDayStarted;
        this.events.GameLoop.TimeChanged -= this.OnTimeChanged;
    }
}
