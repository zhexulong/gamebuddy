using System;
using System.Collections.Generic;
using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

// The two pieces of admission vocabulary the manager still owns, aliased rather than re-spelled: its 94 call sites
// spell the actionability profile unqualified, eight suites spell it `ExecutionManager.AdmissionActionabilityProfile`,
// and the `CanMove` read inside the disposition projection is pinned to that file by
// `tools/audit-stardew-state-coverage.mjs`, so both stay declared there.
using AdmissionProfile = GameBuddy.Stardew.ExecutionManager.AdmissionActionabilityProfile;
using LocalDispositionKind = GameBuddy.Stardew.ExecutionManager.LocalDispositionKind;

namespace GameBuddy.Stardew;

/// <summary>
/// The three things an admission ruling can be, as three types rather than as a nullable receipt plus a look at the
/// reason code.
///
/// <para>
/// A REFUSAL ends the request and answers it with a <see cref="ExecutionState.Rejected"/> receipt; a HOLD keeps the
/// request parked so the tick pump can dispatch it the moment the body frees, and answers with the
/// <see cref="ExecutionManager.HeldRequestMarker"/> receipt the bridge reads as "the Mod is holding this". Those two
/// used to be one return type distinguished at the call site by reading a string, so a caller that skipped the read
/// answered a parked request as if it had been refused. Here the case is the type: a caller that needs the receipt
/// reads <see cref="Withholding"/>, and a caller that needs to know WHICH it is pattern-matches, which it cannot
/// forget to do because <see cref="Admitted"/> carries no receipt at all.
/// </para>
/// </summary>
internal abstract class AdmissionOutcome
{
    private AdmissionOutcome()
    {
    }

    /// <summary>
    /// The receipt that answers the dispatch INSTEAD of performing the action, or <see langword="null"/> when the
    /// request was admitted and the caller must do its work.
    /// </summary>
    internal abstract LocalExecutionReceipt? Withholding { get; }

    /// <summary>Admitted: the caller performs the action; nothing answers on its behalf.</summary>
    internal sealed class Admitted : AdmissionOutcome
    {
        internal override LocalExecutionReceipt? Withholding => null;
    }

    /// <summary>Refused: the request ends here, with the receipt the Host reads as its answer.</summary>
    internal sealed class Refused : AdmissionOutcome
    {
        internal Refused(LocalExecutionReceipt receipt) => this.Receipt = receipt;

        internal LocalExecutionReceipt Receipt { get; }

        internal override LocalExecutionReceipt? Withholding => this.Receipt;
    }

    /// <summary>
    /// Held: the body is held by something that clears on its own inside the bounded window, so the request is parked
    /// and dispatched when it frees. <see cref="Marker"/> is the acceptance the bridge reads as "still waiting".
    /// </summary>
    internal sealed class Held : AdmissionOutcome
    {
        internal Held(LocalExecutionReceipt marker) => this.Marker = marker;

        internal LocalExecutionReceipt Marker { get; }

        internal override LocalExecutionReceipt? Withholding => this.Marker;
    }
}

/// <summary>
/// What an admission ruling asks of the type that owns the terminal commit, the world revision and the accepted
/// night's slot. None of it can happen inside the admission, and none of it is a second authority:
/// <see cref="RememberTerminal"/> is the one terminal seam, <see cref="RefuseHeldRequest"/> is the one hand-rolled
/// commit the terminal-seam gate still records against the manager, and <see cref="SupersedeNightThatHasNotBegun"/>
/// moves the shared revision counter.
/// </summary>
internal interface IAdmissionCommit
{
    /// <summary>The revision a parked request's acceptance is minted with.</summary>
    long CurrentRevision { get; }

    LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence);

    LocalExecutionReceipt RefuseHeldRequest(string requestId, HeldRequest held, string reasonCode, string holdEvidence);

    void SupersedeNightThatHasNotBegun(string incomingExecutionId);
}

/// <summary>
/// Answers one request the admission parked while the actor was Transiently held. <paramref name="refusal"/>
/// is null when the body is free and the request must be dispatched now through the normal path, and is
/// the named refusal when the bounded wait passed without the body freeing. Registered by the bridge,
/// which owns the request as received and produces its response; the admission owns only the wait.
/// </summary>
internal delegate void HeldRequestResolver(string requestId, LocalExecutionReceipt? refusal);

/// <summary>
/// One parked request: the action identity the request was dispatched with, the execution the admission minted for
/// it, the hold it was parked for, and when the bounded wait started.
/// </summary>
internal sealed record HeldRequest(
    string ActionId,
    string ExecutionId,
    string HoldCode,
    string HoldEvidence,
    long ParkedAtUnixMs);

/// <summary>
/// The one admission authority: the mechanical order an executing action shares (identity → actionability → deadline
/// → body exclusivity), the actor it is bound to, and the bounded wait a request is parked in when the body is held by
/// something that clears on its own.
///
/// <para>
/// It reads the body through <see cref="ActiveBodySlots"/> (the one declaration of who owns the actor), the receipts
/// through <see cref="ExecutionReceiptStore"/> (their only writer), the durable admission journal through
/// <see cref="FarmhandExecutionJournal"/>, and commits its rulings through <see cref="IAdmissionCommit"/>.
/// </para>
/// </summary>
internal sealed class ExecutionAdmission
{
    private readonly ActiveBodySlots slots;
    private readonly StardewBodyController controller;
    private readonly ExecutionReceiptStore store;
    private readonly IAdmissionCommit commit;
    private readonly FarmhandExecutionJournal? executionJournal;
    private readonly BridgeScope? executionScope;

    /// <summary>
    /// The durable admission tuple each request's journal write produced, kept for the rest of the request's life: a
    /// receipt transition is persisted with the action identity and canonical request it was admitted under, and a
    /// request whose admission is journalled is never parked, because its tuple is recorded WITHOUT a receipt and a
    /// later dispatch of it would read as a lost-receipt recovery rather than a first dispatch.
    /// </summary>
    private readonly Dictionary<string, FarmhandExecutionAdmission> durableAdmissionsByRequestId = new(StringComparer.Ordinal);

    // Requests whose admission found the actor TRANSIENTLY held, parked so the body can free inside the Mod
    // instead of being refused back to the Agent for a model round-trip. Bounded by
    // WorldModel.TransientRetryWindowMs; keyed by requestId, holding the request as the admission saw it.
    private readonly Dictionary<string, HeldRequest> heldRequestsByRequestId = new(StringComparer.Ordinal);

    private HeldRequestResolver? heldRequestResolver;
    private Func<Farmer?>? testActorResolver;

    internal ExecutionAdmission(
        ActiveBodySlots slots,
        StardewBodyController controller,
        ExecutionReceiptStore store,
        IAdmissionCommit commit,
        FarmhandExecutionJournal? executionJournal,
        BridgeScope? executionScope)
    {
        this.slots = slots;
        this.controller = controller;
        this.store = store;
        this.commit = commit;
        this.executionJournal = executionJournal;
        this.executionScope = executionScope;
    }

    internal void SetTestActorResolver(Func<Farmer?>? resolver) => this.testActorResolver = resolver;

    internal void SetHeldRequestResolver(HeldRequestResolver? resolver) => this.heldRequestResolver = resolver;

    /// <summary>
    /// Whether the named execution still holds work, asked of the stored receipt record:
    /// <see cref="ExecutionReceiptStore.Remember"/> is its only writer, so "the latest receipt is not terminal" is the
    /// one place that knows an execution ended. An execution that never reported - or that has already settled -
    /// answers false, which keeps its lease from suppressing a world interruption.
    /// </summary>
    internal bool IsExecutionActive(string executionId)
    {
        foreach (LocalExecutionReceipt receipt in this.store.ByRequestId.Values)
        {
            if (string.Equals(receipt.ExecutionId, executionId, StringComparison.Ordinal))
                return !receipt.State.IsTerminal();
        }
        return false;
    }

    /// <summary>
    /// The durable admission a request was journalled under, for the receipt transition that carries its action
    /// identity. Absent for every request that was never bound to the journal.
    /// </summary>
    internal bool TryGetDurableAdmission(string requestId, out FarmhandExecutionAdmission admission) =>
        this.durableAdmissionsByRequestId.TryGetValue(requestId, out admission!);

    internal bool TryAdmitNavigation(BridgeExecutionRequest request, string executionId, out string reasonCode)
    {
        if (this.store.HasDurabilityFailure(request.RequestId))
        {
            reasonCode = "execution_durability_quarantined";
            return false;
        }
        reasonCode = "accepted";
        if (this.executionJournal is null || this.executionScope is null || request.Args.Destination is null)
        {
            reasonCode = "execution_durability_unavailable";
            return false;
        }

        if (!this.store.TryBindDispatch(request.RequestId, request.Action, executionId, out reasonCode)
            && reasonCode != "execution_identity_already_bound")
        {
            return false;
        }

        BridgeNavigationDestinationSelector destination = request.Args.Destination;
        FarmhandExecutionAdmission admission = new(
            this.executionScope,
            request.RequestId,
            request.IdempotencyKey,
            request.Action,
            FarmhandCanonicalRequest.NavigationDestination(request.Action, destination.Kind, destination.Label, destination.Ref),
            request.ExpectedRevision,
            request.DeadlineMs,
            executionId);
        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result = this.executionJournal.TryRecordAdmission(admission);
        if (!result.IsSuccess)
        {
            this.store.MarkDurabilityFailure(request.RequestId);
            reasonCode = result.Code.ToString();
            return false;
        }

        this.durableAdmissionsByRequestId[request.RequestId] = admission;
        reasonCode = "accepted";
        return true;
    }

    internal bool TryAdmitCandidate(BridgeExecutionRequest request, string executionId, out string reasonCode)
    {
        if (this.store.HasDurabilityFailure(request.RequestId))
        {
            reasonCode = "execution_durability_quarantined";
            return false;
        }
        reasonCode = "accepted";
        if (this.executionJournal is null || this.executionScope is null)
        {
            reasonCode = "execution_durability_unavailable";
            return false;
        }

        FarmhandCanonicalRequest canonicalRequest;
        if (request.Action == "express_emote" && request.Args.Emote is not null)
        {
            canonicalRequest = FarmhandCanonicalRequest.EmoteRequest(request.Action, request.Args.Emote);
        }
        else if (request.Action == "face_direction" && request.Args.Direction is not null)
        {
            canonicalRequest = FarmhandCanonicalRequest.DirectionRequest(request.Action, request.Args.Direction);
        }
        else
        {
            reasonCode = "invalid_execution_request";
            return false;
        }

        if (!this.store.TryBindDispatch(request.RequestId, request.Action, executionId, out reasonCode)
            && reasonCode != "execution_identity_already_bound")
        {
            return false;
        }

        FarmhandExecutionAdmission admission = new(
            this.executionScope,
            request.RequestId,
            request.IdempotencyKey,
            request.Action,
            canonicalRequest,
            request.ExpectedRevision,
            request.DeadlineMs,
            executionId);
        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result = this.executionJournal.TryRecordAdmission(admission);
        if (!result.IsSuccess)
        {
            this.store.MarkDurabilityFailure(request.RequestId);
            reasonCode = result.Code.ToString();
            return false;
        }

        this.durableAdmissionsByRequestId[request.RequestId] = admission;
        reasonCode = "accepted";
        return true;
    }

    internal bool TryGetBoundActor(out Farmer? actor, out string reasonCode)
    {
        if (this.testActorResolver is not null)
        {
            actor = this.testActorResolver();
            if (actor is null)
            {
                reasonCode = "world_not_ready";
                return false;
            }
            if (this.executionScope is not null
                && !string.Equals(this.executionScope.PlayerId, actor.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
            {
                actor = null;
                reasonCode = "execution_scope_mismatch";
                return false;
            }
            reasonCode = "accepted";
            return true;
        }

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
        {
            actor = null;
            reasonCode = "world_not_ready";
            return false;
        }

        actor = Game1.player;
        if (this.executionScope is not null
            && !string.Equals(this.executionScope.PlayerId, actor.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
        {
            actor = null;
            reasonCode = "execution_scope_mismatch";
            return false;
        }

        reasonCode = "accepted";
        return true;
    }

    /// <summary>
    /// The owner of the body right now, or <see langword="null"/> when nothing of this actor's own is in flight.
    ///
    /// <para>
    /// Null is the fact a WAIT needs: the parked-wait pump re-reads this every tick, so "the body is free again" and
    /// "who was in the way" are one answer from one describer rather than a second predicate that could disagree with
    /// the refusal that parked the request. <see cref="Describe"/> keeps the non-null shape the refusal vocabulary and
    /// the snapshot's occupant projection read.
    /// </para>
    /// </summary>
    internal BodyOwner? Peek() => this.slots.PeekOwner();

    /// <summary>
    /// The SINGLE describer of who owns the body. Every body-exclusivity refusal (the shared admission path and
    /// each action's own guard) mints its receipt through <see cref="RejectBodyOwned"/>, and the snapshot's
    /// occupant projection reads the same result, so no site can carry its own judgement of who is in the way.
    /// </summary>
    internal BodyOwner Describe() =>
        this.Peek() ?? new BodyOwner(ExecutionManager.BodyOwned, "owner_execution_id=unknown;owner_action=unknown;interruptible=false;phase=unknown;cancel_safe=false", false, "unknown", false);

    /// <summary>
    /// The mechanical admission every executing action shares, in the single order invariant 1 fixes: identity →
    /// actionability → deadline → body exclusivity. Geometry, target identity and postconditions are deliberately
    /// absent — they belong to the action body.
    ///
    /// Actionability is disposition-driven (WIA §4.2): the non-Modal profiles require the body to be Idle; the Modal
    /// profile (modal-handling family) requires the modal to actually be present — the open modal is its working
    /// precondition — and is exempt from the body-lease check, while deadline and identity/scope/revision checks stay
    /// unchanged. A running event is a refusal for every action EXCEPT the modal family's two event-acting members,
    /// whose working precondition a cutscene's own dialogue box is.
    ///
    /// Answers <see cref="AdmissionOutcome.Admitted"/> when the request may start. Otherwise it answers the terminal
    /// rejection, whose reasonCode is byte-identical to the pre-convergence inline sequence (behavior equivalence is a
    /// hard requirement: no reasonCode may change), or the park marker for a request that waits the body out.
    /// </summary>
    internal AdmissionOutcome Admit(
        string requestId,
        string executionId,
        long requestedDeadlineMs,
        long nowMs,
        AdmissionProfile profile,
        // The deadline ceiling the caller's action family declares. One minute for an ordinary action; the
        // lifecycle passes its own ten-minute watchdog rather than forking this gate to get one.
        long maxDurationMs = FarmhandActionCatalog.OrdinaryActionCeilingMs)
    {
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string guardReason) || boundActor is null)
            return new AdmissionOutcome.Refused(this.commit.RememberTerminal(requestId, executionId, ExecutionState.Rejected, guardReason, null));

        // WIA §4.2: read the disposition projection instead of re-deriving
        // CanMove/menu/event. Only the Modal profile may act while the world
        // holds a modal; every other profile still requires Idle (menu / event /
        // pass-out / transient → player_not_actionable as before). The explicit
        // eventUp clause keeps the §4.2 "and !eventUp" precondition even if the
        // WorldModel swap ever reorders the precedence.
        ActorWorldFacts admissionFacts = WorldModel.ReadFacts(boundActor);
        ActorDisposition admissionDisposition = WorldModel.Classify(admissionFacts);
        LocalDispositionKind disposition = ExecutionManager.ProjectAdmissionDisposition(admissionDisposition, boundActor);
        bool eventRunning = disposition == LocalDispositionKind.Event || Game1.eventUp;
        bool actsOnRunningEvent = eventRunning && this.RequestHasEventPath(requestId);
        // The cross-day lifecycle is the ONE caller whose own prompt is its precondition: `advance_day` answers the
        // engine's bed question, and that box is what holds the actor. The exemption is the ONE identity
        // (`NativeSleepPrompt`), never "a question is up" - another question, a cutscene, a faint or a transient swing
        // still refuses exactly as it does for every other profile.
        bool ownBedPrompt = profile is AdmissionProfile.Overnight
            && disposition is LocalDispositionKind.Modal
            && WorldModel.HasDialogueBox(admissionFacts)
            && NativeSleepPrompt.IsStanding(Game1.activeClickableMenu as DialogueBox);
        // THE RULING IS THE MODAL FAMILY'S (<see cref="ModalFamily.StandingOf"/>), because a mounted menu means the
        // opposite thing to two profiles: the modal family's working PRECONDITION, and every other profile's hold. The
        // facts stay here - the profile, the projected disposition, whether an event is running, whether THIS request's
        // action acts on one, and whether the engine's own bed prompt is the box standing.
        if (ModalFamily.StandingOf(profile, disposition, eventRunning, actsOnRunningEvent, ownBedPrompt) is ModalFamily.Standing.Obstructed)
        {
            // WIA 4.?? : the refusal NAMES the hold and carries the facts a countermeasure needs. A single
            // `player_not_actionable` for a menu, a cutscene, a faint, an eating animation and a tool swing
            // told the Agent nothing it could act on, and the Agent's only visible option was to retry the
            // same request.
            (string holdCode, string holdEvidence) =
                WorldModel.DescribeCurrentBodyHold(admissionDisposition, admissionFacts, boundActor.CanMove);
            // A Transient hold is the ONE hold that clears on its own inside a bounded window
            // (WorldModel.TransientRetryWindowMs, the very number this evidence publishes as `retry_window_ms`
            // and the number the body loop waits), so a request that meets one is PARKED here and dispatched
            // the moment the body frees, instead of being paid for with a model round-trip whose median is
            // 3.4 s and whose p90 is 25 s (measured 2026-10-19, run g99cross: four refusals in 62 dispatches,
            // each on a follow-up that arrived 49-154 ms after the previous action settled, and each followed
            // by the companion standing still). This is the gate that owns the refusal, so it is also the gate
            // that decides to wait instead - and only while something can resolve the wait: with no bridge
            // attached (a fixture, or the body-program re-entry) the same caller reads the same named refusal
            // it always has. Every other hold - a menu, a cutscene, a faint, a day advance - does not clear
            // inside any bounded window and keeps refusing right here, because parking an action behind one
            // would be exactly the stale execution the revision rules exist to prevent.
            if (disposition == LocalDispositionKind.Transient
                && this.heldRequestResolver is not null
                // A request that already owns a durable journal admission cannot be waited out: its exact
                // tuple is recorded WITHOUT a receipt, so a later dispatch of it would be read as a
                // lost-receipt recovery rather than a first dispatch. Those are the candidate actions, which
                // carry no actionability gate of their own and so never arrive here.
                && !this.durableAdmissionsByRequestId.ContainsKey(requestId))
                return new AdmissionOutcome.Held(this.ParkHeldRequest(requestId, executionId, holdCode, holdEvidence));
            return new AdmissionOutcome.Refused(this.commit.RememberTerminal(requestId, executionId, ExecutionState.Rejected, holdCode, holdEvidence));
        }

        // The event-acting half, refused by a DIFFERENT name. A modal is these actions' working precondition in a
        // cutscene exactly as it is outside one: with nothing on screen there is no box to answer or dismiss, and no
        // action in the catalog advances an event's command program. Refusing that here is what keeps the two facts
        // apart - the cutscene hold every other action reads, and the missing box these two need.
        if (actsOnRunningEvent && !WorldModel.HasMountedModal(admissionFacts))
            return new AdmissionOutcome.Refused(this.commit.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                ExecutionManager.EventHasNoDialogueBox,
                WorldModel.DescribeBodyHold(admissionDisposition, admissionFacts, boundActor.CanMove)));

        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + maxDurationMs)
            return new AdmissionOutcome.Refused(this.commit.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline",
                $"deadline={requestedDeadlineMs};now={nowMs};ceiling={nowMs + maxDurationMs}"));

        if (profile is not AdmissionProfile.Modal
            && (this.slots.Active.Peek() is not null || this.slots.Travel.Peek() is not null || this.slots.Pet.Peek() is not null || this.slots.AnimalProduct.Peek() is not null || this.slots.ItemUse.Peek() is not null || this.slots.ItemPickup.Peek() is not null || this.slots.PedestalTaking.Peek() is not null || this.slots.ToolApproach.Peek() is not null
            // Three long-lived slots were missing here, which meant a mount pending, a bus
            // ride in flight, or an owned overnight could coexist with any action admitted
            // through this path: two executions owning one body. Each of those actions
            // checked only its own slot inline, so nothing caught the overlap.
            || this.slots.MountTransport.Peek() is not null || this.slots.BusRide.Peek() is not null
            // The navigation slot is added for the same reason those three were: a navigation in
            // AwaitingWarp has released active/travel but still owns the body, and
            // IsBodySettled counts it. This chain and IsBodySettled now cover the SAME ownership
            // set — keep them that way, because they answer the same question and a divergence means
            // one of them is lying: this one refuses an action, that one tells the Host the actor is
            // idle. (An earlier version of this comment claimed four slots were missing from THIS
            // list; they were not, and the real gap was the other way round.)
            || this.slots.Navigate.Peek() is not null
            || this.slots.Fishing.Peek() is not null
            // The night is an occupier once it can begin, and ONLY then: a night that has not begun dispatches
            // nothing, so refusing a request against it denies a body nobody is using (that is how the `enter_exit`
            // that would have brought the actor home was refused until the engine passed it out at 2 AM, and how a
            // `sleep` retry came back owned by itself). It keeps its slot in this sentence so the body-set gate still
            // reads the slot, and its one conditional is named here rather than hidden in the describer.
            || (this.slots.DayAdvance.Peek() is not null && !this.slots.NightAcceptedButNotBegun)
            || this.controller.HasActiveExecution))
            return this.RejectBodyOwned(requestId, executionId);

        // The request is admitted, and if it IS a night it now owns the slot exclusively: a night already accepted but
        // not begun cannot keep the handle the next `sleep` is about to take (RequestLocalAdvanceDay holds ONE slot), so
        // it is retired here with its own terminal rather than being overwritten into a receipt nobody ever closes.
        if (profile is AdmissionProfile.Overnight)
            this.commit.SupersedeNightThatHasNotBegun(executionId);

        return new AdmissionOutcome.Admitted();
    }

    /// <summary>
    /// Whether THIS request's action is one whose handler acts on a running event
    /// (<see cref="FarmhandActionCatalog.EventActingActionIds"/>), read from the action identity the dispatch path bound
    /// to the request before the handler ran.
    ///
    /// The bound lineage, not a parameter: `FarmhandActionRouter` writes `request.Action` into the ledger before it
    /// hands the request to a handler, so this is the same identity the receipt carries and a handler cannot claim to
    /// be an action it is not. An unbound request (a direct in-process call outside the router) answers false, which
    /// is the behaviour every caller had before this gate.
    /// </summary>
    private bool RequestHasEventPath(string requestId) =>
        this.store.TryGetActionId(requestId, out string boundActionId)
        && FarmhandActionCatalog.IsEventActing(boundActionId);

    /// <summary>
    /// Mints the named body-exclusivity refusal through the single owner describer.
    ///
    /// One ownership is parked instead of refused: a collision with the actor's OWN in-flight work is a queue. Measured
    /// 2026-10-19 by the hold-absorption gate, a follow-up sent 400 ms into an in-flight move came back
    /// `body_owned_by_movement`; measured 2026-10-19 19:31, a request that met a background `pickup_item` came back
    /// `body_owned_by_activity` and the run went quiet. Either way the Mod already knows the owner clears inside the
    /// bounded window and pays the wait itself rather than the model round-trip whose median is 3.4 s and whose p90 is
    /// 25 s. Everything else - a mount, a bus ride, an owned overnight, a day advance, a journalled admission - keeps
    /// the named refusal it always had. The two exceptions are checked here, together, because they answer one question:
    /// may this request wait for that owner?
    /// </summary>
    internal AdmissionOutcome RejectBodyOwned(string requestId, string executionId)
    {
        BodyOwner owner = this.Describe();
        if (IsQueueableBodyOwner(owner.ReasonCode)
            && this.heldRequestResolver is not null
            // A durable admission is never waited out: its tuple is journalled WITHOUT a receipt, so re-dispatching it
            // later would read as a lost-receipt recovery rather than a first dispatch.
            && !this.durableAdmissionsByRequestId.ContainsKey(requestId))
            return new AdmissionOutcome.Held(this.ParkHeldRequest(requestId, executionId, WaitingForBodyHold(owner.ReasonCode), owner.Evidence));
        return new AdmissionOutcome.Refused(this.commit.RememberTerminal(requestId, executionId, ExecutionState.Rejected, owner.ReasonCode, owner.Evidence));
    }

    /// <summary>
    /// Parks one request whose body is held and answers it with the marker the bridge reads as "still waiting", instead
    /// of starting the native effect: the wait is the Mod's, and the request is dispatched through the path it arrived
    /// on the moment the body frees. The marker is returned rather than stored or published, so the request's single
    /// published identity is the one its dispatch (or its refusal) mints, and the Host never sees a transition for an
    /// action that has not started.
    /// </summary>
    private LocalExecutionReceipt ParkHeldRequest(
        string requestId,
        string executionId,
        string holdCode,
        string holdEvidence)
    {
        string actionId = this.store.TryGetActionId(requestId, out string boundAction) ? boundAction : requestId;
        // The FIRST park owns the request's answer and its window: a caller that retries while the body is
        // still held does not buy itself a fresh window.
        if (!this.heldRequestsByRequestId.ContainsKey(requestId))
            this.heldRequestsByRequestId[requestId] = new HeldRequest(
                actionId,
                executionId,
                holdCode,
                holdEvidence,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        return new LocalExecutionReceipt(executionId, requestId, ExecutionState.Accepted, ExecutionManager.HeldRequestMarker, this.commit.CurrentRevision, holdEvidence, ActionId: actionId);
    }

    /// <summary>
    /// Re-attempts every parked request, once per game tick. The body is re-read through the same authority the
    /// admission reads, so the wait's two ends cannot disagree with the gate that parked the request: the moment it is
    /// free the request goes back to the bridge, which dispatches it through the path it arrived on - every revision,
    /// deadline, profile and ownership check runs again at THAT moment, because this is a wait and not a replay. Past
    /// <see cref="WorldModel.TransientRetryWindowMs"/> the wait ends in the named hold the admission captured on
    /// arrival.
    ///
    /// <para>
    /// That window is enforced whether or not a bridge is left to take the answer. A park exists only while a bridge
    /// does, so a missing resolver means the bridge that parked it went away mid-wait - and the park must still end,
    /// in the same window every other park ends in. It is not a second, shorter deadline: the one branch that mints
    /// <see cref="ExecutionManager.HeldRequestNeverAnsweredPrefix"/> differs in the CODE it names, never in the window.
    /// </para>
    /// </summary>
    internal void PumpHeld()
    {
        if (this.heldRequestsByRequestId.Count == 0)
            return;
        foreach ((string requestId, HeldRequest held) in this.heldRequestsByRequestId.ToArray())
        {
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            (string HoldCode, string HoldEvidence)? hold = this.ReadCurrentHold();
            HeldRequestResolver? resolver = this.heldRequestResolver;
            if (hold is null && resolver is not null)
            {
                this.heldRequestsByRequestId.Remove(requestId);
                this.store.RecordHoldWait(requestId, nowMs - held.ParkedAtUnixMs);
                resolver(requestId, null);
                continue;
            }
            if (nowMs - held.ParkedAtUnixMs <= WorldModel.TransientRetryWindowMs)
                continue;
            // The wait ended in a hold that is still in force. While it is the parked hold, the code and
            // evidence are the pair the admission captured on arrival - byte for byte the refusal the Agent
            // would have read then; a world that changed behind the wait is named as it is NOW, because
            // pointing the Agent at a hold that has ended would give it the wrong countermeasure. A body that
            // freed with no bridge left to take the dispatch names the hold that arrived with the park, which is
            // the only one this wait can claim.
            (string holdCode, string holdEvidence) = hold is null || hold.Value.HoldCode == held.HoldCode
                ? (held.HoldCode, held.HoldEvidence)
                : (hold.Value.HoldCode, hold.Value.HoldEvidence);
            this.heldRequestsByRequestId.Remove(requestId);
            if (resolver is null)
            {
                this.commit.RefuseHeldRequest(requestId, held, $"{ExecutionManager.HeldRequestNeverAnsweredPrefix}{holdCode}", holdEvidence);
                continue;
            }
            resolver(requestId, this.commit.RefuseHeldRequest(requestId, held, holdCode, holdEvidence));
        }
    }

    /// <summary>
    /// The hold the body is under right now, or null when it is free. Read through the same authority the admission
    /// reads, so the wait can never dispatch into a body the admission would have refused.
    ///
    /// <para>
    /// Two things can hold the body, and this asks about BOTH: the actor's disposition (a menu, a cutscene, a tool
    /// swing) and an execution of the actor's own that owns it. The second is what makes a queued request wait for the
    /// owner that parked it instead of dispatching on the next tick straight back into `body_owned_by_activity`, and the
    /// code it reports is the wait's own name for that owner.
    /// </para>
    /// </summary>
    private (string HoldCode, string HoldEvidence)? ReadCurrentHold()
    {
        if (!this.TryGetBoundActor(out Farmer? boundActor, out _) || boundActor is null)
            return null;
        ActorWorldFacts facts = WorldModel.ReadFacts(boundActor);
        ActorDisposition disposition = WorldModel.Classify(facts);
        LocalDispositionKind projected = ExecutionManager.ProjectAdmissionDisposition(disposition, boundActor);
        if (projected == LocalDispositionKind.Idle)
            return this.Peek() is { } owner
                ? (WaitingForBodyHold(owner.ReasonCode), owner.Evidence)
                : null;
        (string holdCode, string holdEvidence) = WorldModel.DescribeCurrentBodyHold(disposition, facts, boundActor.CanMove);
        return (holdCode, holdEvidence);
    }

    /// <summary>
    /// Ends every parked wait at once, with the named refusal for the hold that is still in force. A
    /// lifecycle boundary or a halt must never leave a request parked to dispatch later: the wait belongs to
    /// the hold, and the world that held the body is the one that just ended.
    /// </summary>
    internal void Close()
    {
        foreach ((string requestId, HeldRequest held) in this.heldRequestsByRequestId.ToArray())
        {
            this.heldRequestsByRequestId.Remove(requestId);
            if (this.heldRequestResolver is null)
                continue;
            this.heldRequestResolver(requestId, this.commit.RefuseHeldRequest(requestId, held, held.HoldCode, held.HoldEvidence));
        }
    }

    /// <summary>
    /// The hold a request waits out when the actor's OWN in-flight execution owns the body, named after that owner and
    /// carrying the owner's own evidence (`owner_execution_id`, `owner_action`).
    ///
    /// <para>
    /// The name is derived from the owner code rather than spelled again, so the wait and the refusal vocabulary cannot
    /// drift. It travels on the existing receipt fields - <c>reasonCode</c> plus the evidence detail string - which is
    /// why no wire field was added for it.
    /// </para>
    /// </summary>
    private static string WaitingForBodyHold(string ownerCode) => $"{ExecutionManager.WaitingForBodyPrefix}{ownerCode}";

    /// <summary>
    /// Whether a request that collides with this owner may WAIT for it instead of being refused.
    ///
    /// <para>
    /// These are the executions whose whole life is one short intent of the actor's own: an in-flight local move and the
    /// activity family (petting, animal produce, item use, pickup, pedestal taking). They end on their own inside the
    /// bounded window, so the collision is a QUEUE. The other owners are not queued: a ride, a map transition, a
    /// navigation or a committed night outlives the window every time, so parking behind one would delay the same named
    /// refusal and hold a request that cannot be dispatched in time. A request whose admission tuple is JOURNALLED is
    /// refused for a different reason - a different lineage owns it, and a later dispatch would read as a lost-receipt
    /// recovery - which <see cref="RejectBodyOwned"/> checks beside this one.
    /// </para>
    /// </summary>
    private static bool IsQueueableBodyOwner(string ownerCode) =>
        ownerCode is ExecutionManager.BodyOwnedByMovement or ExecutionManager.BodyOwnedByActivity;

    /// <summary>
    /// The named refusal for the ONE ownership the body controller itself can hold: an in-flight local move, which
    /// a newer movement directive may supersede. Shared with <see cref="StardewBodyController"/> so the code, the
    /// action and the interruptible verdict keep the single definition the owner table gives them.
    /// </summary>
    internal static (string ReasonCode, string Evidence) LocalMoveOwner(string? executionId) =>
        (ExecutionManager.BodyOwnedByMovement, $"owner_execution_id={ActiveBodySlots.OwnerToken(executionId)};owner_action=move_to_tile;interruptible=true");
}
