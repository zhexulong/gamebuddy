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
