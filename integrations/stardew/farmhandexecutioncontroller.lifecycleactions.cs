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
    /// Farmers that must be online before an <c>advance_day</c> execution may
    /// start. Default 1 is the honest single-player minimum; a co-op profile
    /// declares 2, because a night that starts while the other player is still
    /// connecting would otherwise take the single-player native path and advance
    /// the day alone.
    /// </summary>
    private int lifecycleMinimumOnlineFarmers = 1;

    /// <summary>
    /// Declares the profile's co-op minimum for the <c>advance_day</c> execution
    /// path. The evidence-only file lane carries its own copy of this value; this
    /// one governs the wire action so an explicit request cannot silently become
    /// a solo night when the other player drops between dispatch and execution.
    /// </summary>
    internal void ConfigureLifecycleMinimumFarmers(int minimumOnlineFarmers)
    {
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
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        // Scope-bound actor proof precedes readiness, exactly as the converged
        // admission path does: a caller that is not the scoped actor must be
        // refused for that reason, not for where it happens to be standing.

        // Scope-bound actor proof precedes readiness, exactly as the converged
        // admission path does: a caller that is not the scoped actor must be
        // refused for that reason, not for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);

        // Shared mechanical admission (identity -> actionability -> deadline -> body exclusivity), with the
        // LIFECYCLE's own ceiling: a co-op night legitimately waits ten minutes, so the ordinary one-minute
        // action ceiling cannot cover it. That mismatch was the whole reason this site stayed forked, and the
        // ceiling is now a parameter of the shared admission rather than a reason to bypass it.
        //
        // The profile is the Overnight one because the engine's own bed prompt may already be standing when the request
        // arrives: it is this action's precondition, and the lifecycle answers it. Refusing it here is how a night's
        // intent was left for the Agent to discharge by answering the question itself, which crosses a day with no
        // receipt (round41).
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs,
                AdmissionActionabilityProfile.Overnight, FarmhandActionCatalog.LifecycleWatchdogMs) is { } admissionRefusal)
            return admissionRefusal;

        SleepAndAdvanceDayLifecycleConfig config = new()
        {
            Enable = true,
            // An execution-owned night is observable through its receipt, so it
            // writes no evidence file; the configured evidence lane is separate.
            EvidencePath = string.Empty,
            MinimumOnlineFarmers = this.lifecycleMinimumOnlineFarmers,
            // A dispatched night waits on another player's own decision to sleep,
            // which is not an animation and has no natural upper bound. These
            // budgets sit just inside the action's 600s watchdog so a night that
            // does complete is never cut short, while one that will not complete
            // still terminates with the honest truth instead of hanging.
            TimeoutSeconds = 540,
            ReadyBarrierFrameBudget = 18000,
        };
        SleepAndAdvanceDayLifecycle? lifecycle = SleepAndAdvanceDayLifecycle.TryStart(this.monitor, config);
        if (lifecycle is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "lifecycle_configuration_invalid",
                $"enable={config.Enable};timeout_seconds={config.TimeoutSeconds};settle_frames={config.SettleFrameBudget};minimum_online_farmers={config.MinimumOnlineFarmers}");

        this.activeDayAdvance = new ActiveDayAdvance(executionId, requestId, lifecycle);
        return this.RememberTerminal(
            requestId,
            executionId,
            ExecutionState.Accepted,
            "accepted",
            "target=own_bed;never_direct_new_day=true");
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
            // Pre-start eligibility refusals. Nothing native ran, so nothing is uncertain about the world: the night was
            // declined and the reason says why. Reporting these as Uncertain claimed doubt about an effect that never
            // existed, and it hid a plain answer ("you are not home") behind the vocabulary reserved for real doubt.
            "not_home" => ExecutionState.Rejected,
            "time_paused" => ExecutionState.Rejected,
            "menu_open" => ExecutionState.Rejected,
            "dialogue_up" => ExecutionState.Rejected,
            "event_up" => ExecutionState.Rejected,
            "already_new_day" => ExecutionState.Rejected,
            "passed_out" => ExecutionState.Rejected,
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
        this.ledger.Remember(receipt);
        this.AddTrace(receipt);
        this.ledger.PublishIdleAfterRelease(active.ExecutionId, active.RequestId);
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
