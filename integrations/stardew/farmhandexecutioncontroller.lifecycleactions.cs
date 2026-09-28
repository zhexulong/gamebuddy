using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// The cross-day lifecycle as a real execution action.
///
/// <para>
/// The gameplay catalog models this intent as <c>coordinated</c> because a night
/// needs a host save and, in shared worlds, every required farmer's own ready
/// state. That is a statement about who satisfies the intent, not a licence to
/// invent a second receipt authority: the AI's own share is one bounded native
/// lifecycle, and it is dispatched and receipted through the one execution
/// pipeline every other action uses.
/// </para>
/// <para>
/// The native work itself lives in <see cref="SleepAndAdvanceDayLifecycle"/>,
/// which is the mechanism owner. This partial only performs the mechanical
/// admission every action performs (scope-bound actor, world readiness, deadline,
/// body ownership) and projects the lifecycle's terminal into the ordinary
/// receipt shape.
/// </para>
/// </summary>
internal sealed partial class ExecutionManager
{
    /// <summary>One owned night. The dispatch identity is stored with the mechanism.</summary>
    private sealed record ActiveDayAdvance(string ExecutionId, string RequestId, SleepAndAdvanceDayLifecycle Lifecycle);

    private ActiveDayAdvance? activeDayAdvance;

    /// <summary>
    /// Optional evidence file for the lifecycle. An execution-owned night does not
    /// need one: it is observable through its receipt. The fixture lane sets this
    /// so its existing live evidence keeps working.
    /// </summary>
    private string? lifecycleEvidencePath;

    /// <summary>Farmers that must be online before a co-op night may start.</summary>
    private int lifecycleMinimumOnlineFarmers = 1;

    internal void ConfigureLifecycleEvidence(string? evidencePath, int minimumOnlineFarmers)
    {
        this.lifecycleEvidencePath = evidencePath;
        this.lifecycleMinimumOnlineFarmers = Math.Clamp(minimumOnlineFarmers, 1, 8);
    }

    internal bool HasActiveDayAdvance => this.activeDayAdvance is not null;

    /// <summary>
    /// Dispatches <c>advance_day</c>. Returns <c>Accepted</c> immediately, like
    /// every other multi-frame action: the night cannot be observed inside one
    /// call, and a synchronous terminal here would have to forge the save and
    /// day-start facts it is supposed to be observing.
    /// </summary>
    public LocalExecutionReceipt RequestLocalAdvanceDay(string requestId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Scope-bound actor proof precedes readiness, exactly as the converged
        // admission path does: a caller that is not the scoped actor must be
        // refused for that reason, not for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);

        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);

        // The lifecycle needs the ceiling its own watchdog declares; the ordinary
        // one-minute action ceiling cannot cover a co-op night.
        if (requestedDeadlineMs <= nowMs
            || requestedDeadlineMs > nowMs + FarmhandActionCatalog.LifecycleWatchdogMs)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);

        if (this.active is not null
            || this.activeTravel is not null
            || this.activeNavigate is not null
            || this.activePet is not null
            || this.activeAnimalProduct is not null
            || this.activeItemUse is not null
            || this.activeItemPickup is not null
            || this.activeDayAdvance is not null
            || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);

        SleepAndAdvanceDayLifecycleConfig config = new()
        {
            Enable = true,
            EvidencePath = this.lifecycleEvidencePath ?? string.Empty,
            MinimumOnlineFarmers = this.lifecycleMinimumOnlineFarmers,
        };
        SleepAndAdvanceDayLifecycle? lifecycle = SleepAndAdvanceDayLifecycle.TryStart(this.monitor, config);
        if (lifecycle is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "lifecycle_configuration_invalid", null);

        this.activeDayAdvance = new ActiveDayAdvance(executionId, requestId, lifecycle);
        LocalExecutionReceipt accepted = new(
            executionId,
            requestId,
            ExecutionState.Accepted,
            "accepted",
            this.revision,
            "target=own_bed;never_direct_new_day=true");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>
    /// Advances the owned night from the ordinary game-thread update. The terminal
    /// is published exactly once through the one ledger, so an accepted execution
    /// never ends without a receipt.
    /// </summary>
    private void UpdateActiveDayAdvance()
    {
        if (this.activeDayAdvance is not { } active)
            return;

        if (!active.Lifecycle.Update())
            return;

        this.activeDayAdvance = null;
        this.revision++;
        ExecutionState state = active.Lifecycle.TerminalState switch
        {
            "passed" => ExecutionState.Succeeded,
            // "waiting" is the honest coordinated terminal: the actor is at its own
            // bed and has declared local ready, but the native barrier is owned by
            // the other players. It is neither a failure nor a completion.
            "waiting" => ExecutionState.Blocked,
            "blocked" => ExecutionState.Blocked,
            _ => ExecutionState.Uncertain,
        };
        LocalExecutionReceipt receipt = new(
            active.ExecutionId,
            active.RequestId,
            state,
            active.Lifecycle.TerminalReasonCode,
            this.revision,
            active.Lifecycle.TerminalEvidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        this.PublishIdleAfterRelease(active.ExecutionId, active.RequestId);
    }

    /// <summary>Native event edges forwarded to an owned night. No-ops when none is active.</summary>
    internal void ObserveDayAdvanceSaved()
    {
        this.activeDayAdvance?.Lifecycle.ObserveSaved();
    }

    internal void ObserveDayAdvanceDayStarted()
    {
        this.activeDayAdvance?.Lifecycle.ObserveDayStarted();
    }
}
