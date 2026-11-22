using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    private ActiveDayAdvance? activeDayAdvance => this.slots.DayAdvance.Peek();

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
        if (this.BeginGuardedLocalExecution(requestId, out _, out string executionId, out long nowMs) is LocalExecutionReceipt guardRefusal)
            return guardRefusal;

        // WHERE SHE STANDS IS THE NIGHT'S OWN PRECONDITION, AND IT IS ANSWERED IN THE SAME CALL.
        //
        // The refusal used to arrive a few frames after this one had already answered `accepted`, from inside the
        // lifecycle's eligibility gate: the night then waited for the actor to walk home, and the walk home is a node of
        // a DIFFERENT programme - which the submission path refuses while this node is still running
        // (`planLookaheadRefusals`). Measured 2026-11-22 (`round93`, `plan_463`): `sleep()` submitted alone from Town
        // reported `not_home` for 308 s, the `dismiss_modal` that could have changed the screen was refused
        // `plan_action_not_composable_ahead`, and the engine's 2:00 AM pass-out ended the run with her money lost.
        //
        // The declaration is the lifecycle's own `HomeOf` - the same one the eligibility gate refuses from and the same
        // one the projection states to the companion (`sleepAdmitsHere`, `snapshot-projection.ts` `sleepDayEndText`:
        // "`sleep()` is refused here (`not_home`)"). Reading it here is not a second copy of that rule: it is the same
        // declaration read one layer earlier, which is where the bridge receipt is minted, and the game-thread re-check in
        // `TryEnterEligibility` still runs when the world moves her while the night is in flight.
        if (SleepAndAdvanceDayLifecycle.HomeOf(Game1.player.currentLocation) is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, SleepAndAdvanceDayLifecycle.NotHomeReason,
                $"location={Game1.player.currentLocation.NameOrUniqueName}");

        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs,
                AdmissionActionabilityProfile.Overnight, FarmhandActionCatalog.LifecycleWatchdogMs) is { } admissionRefusal)
            return admissionRefusal;

        SleepAndAdvanceDayLifecycleConfig config = new()
        {
            Enable = true,
            EvidencePath = string.Empty,
            MinimumOnlineFarmers = this.lifecycleMinimumOnlineFarmers,
            TimeoutSeconds = 540,
            ReadyBarrierFrameBudget = 18000,
        };
        SleepAndAdvanceDayLifecycle? lifecycle = SleepAndAdvanceDayLifecycle.TryStart(this.monitor, config);
        if (lifecycle is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "lifecycle_configuration_invalid",
                $"enable={config.Enable};timeout_seconds={config.TimeoutSeconds};settle_frames={config.SettleFrameBudget};minimum_online_farmers={config.MinimumOnlineFarmers}");

        this.slots.DayAdvance.Assign(new ActiveDayAdvance(executionId, requestId, lifecycle));
        return this.RememberTerminal(
            requestId,
            executionId,
            ExecutionState.Accepted,
            "accepted",
            "target=own_bed;never_direct_new_day=true");
    }

    private void UpdateActiveDayAdvance()
    {
        if (this.activeDayAdvance is not { } active)
            return;

        if (!active.Lifecycle.Update())
            return;

        this.slots.DayAdvance.Clear();
        this.revision++;
        ExecutionState state = active.Lifecycle.TerminalState switch
        {
            "passed" => ExecutionState.Succeeded,
            SleepAndAdvanceDayLifecycle.NotHomeReason => ExecutionState.Rejected,
            "time_paused" => ExecutionState.Rejected,
            "menu_open" => ExecutionState.Rejected,
            "dialogue_up" => ExecutionState.Rejected,
            "event_up" => ExecutionState.Rejected,
            "already_new_day" => ExecutionState.Rejected,
            "passed_out" => ExecutionState.Rejected,
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

/// <summary>One accepted night this Mod owns until its lifecycle settles: the only state <c>advance_day</c> keeps.</summary>
internal sealed record ActiveDayAdvance(string ExecutionId, string RequestId, SleepAndAdvanceDayLifecycle Lifecycle);