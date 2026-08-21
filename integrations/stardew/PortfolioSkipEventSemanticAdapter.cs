using System.Security.Cryptography;
using System.Text;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// Target-version semantic edge for the skip_event action. All facts and the
/// native skipEvent call are owned by the game thread; the bridge supplies only
/// the immutable execution authority tuple.
/// </summary>
internal sealed class PortfolioSkipEventSemanticAdapter
    : IPortfolioSkipEventObservationAdapter, IPortfolioSkipEventPendingOwner
{
    private readonly PortfolioConfig config;
    private readonly Func<bool> isBindingCurrent;
    private readonly Func<long> nextRevision;
    private readonly Func<PortfolioSkipEventNativeSkipObservation, bool> observeNativeSkip;
    private readonly Func<PortfolioSkipEventPostconditionObservation, PortfolioSkipEventActionReceipt> observePostcondition;
    private readonly Func<string, string, string, string, long, PortfolioScope, PortfolioSkipEventActionReceipt> fail;
    private PendingExecution? pending;

    internal PortfolioSkipEventSemanticAdapter(
        PortfolioConfig config,
        Func<bool> isBindingCurrent,
        Func<long> nextRevision,
        Func<PortfolioSkipEventNativeSkipObservation, bool> observeNativeSkip,
        Func<PortfolioSkipEventPostconditionObservation, PortfolioSkipEventActionReceipt> observePostcondition,
        Func<string, string, string, string, long, PortfolioScope, PortfolioSkipEventActionReceipt> fail)
    {
        this.config = config;
        this.isBindingCurrent = isBindingCurrent;
        this.nextRevision = nextRevision;
        this.observeNativeSkip = observeNativeSkip;
        this.observePostcondition = observePostcondition;
        this.fail = fail;
    }

    public PortfolioSkipEventFreshObservation CreateFreshObservation(
        PortfolioSkipEventActionRequest request,
        PortfolioScope scope,
        long revision)
    {
        bool playerAvailable = Game1.player is not null
            && Game1.player.UniqueMultiplayerID.ToString() == scope.LocalPlayerId;
        bool worldReady = Context.IsWorldReady && Game1.hasLoadedGame;
        bool singlePlayer = !Context.IsMultiplayer && Game1.IsMasterGame
            && Game1.getAllFarmers().Count() == 1
            && Game1.player is not null
            && Game1.player.UniqueMultiplayerID == Game1.MasterPlayer.UniqueMultiplayerID;
        bool policyAllowed = this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SkipEventAction);
        bool eventObserved = false;
        bool eventSkippable = false;
        string? opaqueEventTarget = null;
        string? nativeEventId = null;
        if (worldReady && singlePlayer && Game1.player is not null)
        {
            Event? currentEvent = Game1.CurrentEvent;
            eventObserved = currentEvent is not null;
            eventSkippable = currentEvent?.skippable ?? false;
            // Opaque event id from stable request/scope/revision facts, never event text.
            nativeEventId = BuildOpaqueEventId(
                request.RequestId, request.TraceId, scope, revision);
            opaqueEventTarget = nativeEventId;
        }
        return new PortfolioSkipEventFreshObservation(
            request.RequestId, request.TraceId, revision, scope,
            Fresh: true,
            PlayerAvailable: playerAvailable && singlePlayer,
            WorldReady: worldReady,
            PolicyAllowed: policyAllowed,
            EventObserved: eventObserved,
            EventSkippable: eventSkippable,
            OpaqueEventTarget: opaqueEventTarget,
            NativeEventId: nativeEventId);
    }

    public bool IsAvailable => this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SkipEventAction)
        && Context.IsWorldReady && Game1.hasLoadedGame && this.isBindingCurrent();

    public bool RequestSkipEvent(
        PortfolioSkipEventAdapterContext context,
        out PortfolioSkipEventAdapterResult? result)
    {
        result = null;
        PendingExecution? existing = this.pending;
        if (existing is not null && !Matches(existing, context))
            return false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.isBindingCurrent() || !Context.IsWorldReady || !Game1.hasLoadedGame)
            return false;
        if (Context.IsMultiplayer || !Game1.IsMasterGame
            || Game1.getAllFarmers().Count() != 1 || Game1.player is null
            || Game1.player.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID
            || Game1.player.UniqueMultiplayerID.ToString() != context.Scope.LocalPlayerId)
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SkipEventAction))
            return false;

        // Event.skipEvent() is the native direct event terminal. Unlike the
        // player UI affordance, it has no skippable guard; retain skippable as
        // observation evidence, but require only a live native Event here.
        Event? currentEvent = Game1.CurrentEvent;
        if (currentEvent is null)
            return false;
        bool eventSkippable = currentEvent.skippable;

        // Enforce only one matching pending context.
        PendingExecution candidate = existing ?? new PendingExecution(
            context.RequestId, context.TraceId, context.ExecutionId, context.Scope,
            context.OpaqueEventTarget, context.NativeEventId,
            context.ExpectedRevision, context.DeadlineMs, context.CancellationToken,
            NativeSkipRevision: 0);
        candidate = candidate with { ExecutionId = context.ExecutionId };

        // Final re-check before native call.
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.isBindingCurrent()
            || !ReferenceEquals(Game1.CurrentEvent, currentEvent))
            return false;

        this.pending = candidate;
        try
        {
            // Exact native edge: currentEvent.skipEvent() once.
            // No input APIs, menu mutation, or eventsSeen writes.
            currentEvent.skipEvent();
        }
        catch
        {
            this.pending = null;
            return false;
        }

        PendingExecution? armed = this.pending;
        if (armed is null || !Matches(armed, context))
            return false;

        // Store pending then call observeNativeSkip with fresh fact/revision.
        long nativeSkipRevision = this.nextRevision();
        armed = armed with { NativeSkipRevision = nativeSkipRevision };
        this.pending = armed;

        PortfolioSkipEventNativeSkipObservation nativeSkipObservation = new(
            context.RequestId, context.TraceId, context.ExecutionId, nativeSkipRevision, context.Scope,
            Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true,
            EventObserved: true, NativeSkipObserved: true,
            context.OpaqueEventTarget, context.NativeEventId);
        try
        {
            if (!this.observeNativeSkip(nativeSkipObservation))
            {
                TryFail(armed);
                return false;
            }
        }
        catch
        {
            TryFail(armed);
            return false;
        }

        result = new PortfolioSkipEventAdapterResult(
            context.RequestId, context.TraceId, context.ExecutionId, context.Scope,
            nativeSkipRevision, EventObserved: true, EventSkippable: eventSkippable,
            context.OpaqueEventTarget, context.NativeEventId, NativeSkipIssued: true);
        return true;
    }

    /// <summary>
    /// Game-thread watchdog for deadline expiry. Called from the update loop;
    /// terminalizes the pending execution when the deadline has passed.
    /// </summary>
    internal void Watchdog(long nowMs)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null || nowMs < candidate.DeadlineMs)
            return;
        TryFail(candidate);
        if (this.pending is PendingExecution current && current.ExecutionId == candidate.ExecutionId)
            DiscardPending(candidate.ExecutionId);
    }

    /// <summary>
    /// Called after each game-state update to observe the clean postcondition
    /// once the event has ended. Rereads CurrentEvent null, eventUp false,
    /// dialogueUp false, activeClickableMenu null, and player.CanMove.
    /// A transient native UI/action lock remains pending; only a deadline or
    /// invalidated binding may terminalize it uncertain.
    /// </summary>
    internal void ObserveAfterEventUpdate()
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null)
            return;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= candidate.DeadlineMs
            || !this.isBindingCurrent())
        {
            TryFail(candidate);
            DiscardPending(candidate.ExecutionId);
            return;
        }

        bool eventCleared = Game1.CurrentEvent is null;
        if (!eventCleared)
            return; // Event still active; wait for the next update.

        bool stateClean = !Game1.eventUp && !Game1.dialogueUp
            && Game1.activeClickableMenu is null
            && Game1.player is not null && Game1.player.CanMove;
        if (!stateClean)
            return; // Native skip cleanup is still settling; reread next update.

        long revision = this.nextRevision();
        PortfolioSkipEventPostconditionObservation postcondition = new(
            candidate.RequestId, candidate.TraceId, candidate.ExecutionId, revision, candidate.Scope,
            Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true,
            EventCleared: true, PostEventStateClean: stateClean,
            candidate.OpaqueEventTarget, candidate.NativeEventId);
        try
        {
            _ = this.observePostcondition(postcondition);
        }
        catch
        {
            TryFail(candidate);
        }
        finally
        {
            DiscardPending(candidate.ExecutionId);
        }
    }

    /// <summary>
    /// Called by the coordinator during invalidation/cancel; removes the pending
    /// execution without terminalizing — the coordinator owns the terminal receipt.
    /// </summary>
    internal void DiscardPendingForInvalidation()
        => this.pending = null;

    public void DiscardPending(string executionId)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null || candidate.ExecutionId != executionId)
            return;
        this.pending = null;
    }

    private void TryFail(PendingExecution candidate)
    {
        try
        {
            _ = this.fail(candidate.RequestId, candidate.TraceId, candidate.ExecutionId,
                "native_operation_uncertain", this.nextRevision(), candidate.Scope);
        }
        catch
        {
            // The coordinator still terminalizes and clears correlation state.
        }
    }

    private static bool Matches(PendingExecution candidate, PortfolioSkipEventAdapterContext context) =>
        candidate.RequestId == context.RequestId
        && candidate.TraceId == context.TraceId
        && candidate.Scope.Equals(context.Scope)
        && candidate.OpaqueEventTarget == context.OpaqueEventTarget
        && candidate.NativeEventId == context.NativeEventId
        && candidate.ExpectedRevision == context.ExpectedRevision
        && candidate.DeadlineMs == context.DeadlineMs
        && candidate.CancellationToken == context.CancellationToken;

    private static string BuildOpaqueEventId(
        string requestId,
        string traceId,
        PortfolioScope scope,
        long revision)
    {
        string canonicalFacts = string.Join("\n", new[]
        {
            "requestId=" + requestId,
            "traceId=" + traceId,
            "scope.integrationId=" + scope.IntegrationId,
            "scope.topology=" + scope.Topology,
            "scope.saveId=" + scope.SaveId,
            "scope.worldId=" + scope.WorldId,
            "scope.localPlayerId=" + scope.LocalPlayerId,
            "scope.companionId=" + scope.CompanionId,
            "scope.bindingGeneration=" + scope.BindingGeneration,
            "scope.bindingHash=" + scope.BindingHash,
            "revision=" + revision
        });
        return "skip_event_opaque_"
            + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalFacts))).ToLowerInvariant();
    }

    private sealed record PendingExecution(
        string RequestId,
        string TraceId,
        string ExecutionId,
        PortfolioScope Scope,
        string? OpaqueEventTarget,
        string? NativeEventId,
        long ExpectedRevision,
        long DeadlineMs,
        string CancellationToken,
        long NativeSkipRevision);
}