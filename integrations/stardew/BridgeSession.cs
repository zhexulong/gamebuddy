using System.Security.Cryptography;
using System.Linq;
using System.Text.Json;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew;

/// <summary>Transport-neutral, SMAPI-game-thread-only authenticated session.</summary>
internal sealed class BridgeSession
{
    private const int MaximumRememberedIdempotencyKeys = 256;
    private const int MaximumPendingPlayerControls = 64;
    private const int MaximumRememberedCancelIdentities = 256;
    private readonly ExecutionManager executions;
    private readonly FarmhandActionRouter actionRouter;
    private readonly BridgeScope scope;
    private readonly string token;
    private readonly Func<FarmhandCapabilityPublication> capabilityPublicationProvider;
    private readonly Func<string> presentationLocale;
    private readonly Func<DerivedDestinationSet?> navigationSetProvider;
    private readonly NavigationReferenceStore navigationReferences;
    private readonly string navigationRuntimeInstanceId = Guid.NewGuid().ToString("N");
    private long navigationObservationSequence;
    private readonly Dictionary<string, IdempotentExecution> idempotency = new(StringComparer.Ordinal);
    private readonly Queue<string> idempotencyOrder = new();
    // Presentation receipts cannot be evicted or cleared on re-authentication:
    // a duplicate authenticated request must never become a second native chat
    // line merely because its bridge transport generation changed.
    private readonly Dictionary<string, IdempotentPresentation> presentations = new(StringComparer.Ordinal);
    // System notices are separate from model expressions but retain the same
    // terminal-before-native-send rule so transport replay cannot duplicate chat.
    private readonly Dictionary<string, IdempotentSystemNotice> systemNotices = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> pendingPlayerControls = new(StringComparer.Ordinal);
    // Cancel identities survive re-authentication exactly like idempotency
    // records: a duplicate or stale bridge cancel can never settle a different
    // execution merely because its transport generation changed.
    private readonly Dictionary<string, CancelIdentityRecord> cancelIdentities = new(StringComparer.Ordinal);
    private readonly Queue<string> cancelIdentityOrder = new();
    private long authenticatedGeneration = -1;
    private long presentationEpoch;

    private readonly BridgeRuntimeAttestation runtimeAttestation;

    internal BridgeSession(
        ExecutionManager executions,
        FarmhandActionRouter actionRouter,
        BridgeScope scope,
        string token,
        Func<FarmhandCapabilityPublication> capabilityPublicationProvider,
        Func<string>? presentationLocale = null,
        Func<DerivedDestinationSet?>? navigationSetProvider = null,
        NavigationReferenceStore? navigationReferences = null,
        BridgeRuntimeAttestation? runtimeAttestation = null)
    {
        this.runtimeAttestation = runtimeAttestation ?? BridgeRuntimeAttestation.Default;
        this.executions = executions;
        this.actionRouter = actionRouter ?? throw new ArgumentNullException(nameof(actionRouter));
        this.scope = scope;
        this.token = token;
        this.capabilityPublicationProvider = capabilityPublicationProvider ?? throw new ArgumentNullException(nameof(capabilityPublicationProvider));
        this.presentationLocale = presentationLocale ?? NativeChatPresentationPolicy.CurrentBcp47Locale;
        this.navigationSetProvider = navigationSetProvider ?? (() => null);
        this.navigationReferences = navigationReferences ?? new NavigationReferenceStore();
        this.executions.SetNavigationRuntimeFactory(() => new NavigationRuntimeSnapshot(
            this.navigationReferences,
            this.navigationRuntimeInstanceId,
            this.scope,
            this.navigationSetProvider,
            new Game1NavigationWorldSource()));
    }

    internal bool TryAuthenticate(long generation, BridgeEnvelope<BridgeHello>? envelope, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string reasonCode)
    {
        acknowledgement = null;
        if (!IsValidEnvelope(envelope, "hello", out reasonCode) || envelope!.Payload is null || !FixedEquals(envelope.Payload.Token, this.token))
        { reasonCode = "authentication_failed"; return false; }
        if (this.authenticatedGeneration == generation) { reasonCode = "already_authenticated"; return false; }
        if (!TryCurrentPresentationLocale(out string locale))
        { reasonCode = "invalid_presentation_locale"; return false; }
        this.authenticatedGeneration = generation;
        this.pendingPlayerControls.Clear();
        FarmhandCapabilityPublication publication = this.capabilityPublicationProvider();
        FarmhandCapabilitySet capabilitySet = publication.CapabilitySet;
        acknowledgement = Reply("hello_ack", envelope.CorrelationId, new BridgeHelloAck(
            Guid.NewGuid().ToString("N"),
            capabilitySet.AdvertisedCapabilityIds,
            publication.CapabilityRevision,
            capabilitySet.EnabledActionIds,
            locale,
            FarmhandActionCatalog.Registrations.Select(registration => new FarmhandActionRegistrationWire(
                registration.ActionId,
                registration.FamilyId,
                registration.IdentityVersion,
                registration.Lifecycle.ToWireValue(),
                registration.Kind.ToWireValue())).ToArray(),
            this.runtimeAttestation.RuntimeRole,
            this.runtimeAttestation.LaunchGeneration));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryObserve(long generation, BridgeEnvelope<BridgeObserveRequest>? envelope, out BridgeEnvelope<BridgeSnapshot>? response, out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "observe_request", out reasonCode)) return false;
        if (!TryCurrentPresentationLocale(out string locale))
        { reasonCode = "invalid_presentation_locale"; return false; }
        BridgeSnapshot snapshot = this.executions.CreateBridgeSnapshot() with { PresentationLocale = locale };
        response = Reply("snapshot", envelope!.CorrelationId, snapshot);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryNavigationRead(long generation, BridgeEnvelope<BridgeNavigationReadRequest>? envelope, out BridgeEnvelope<BridgeNavigationReadResult>? response, out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "navigation_read_request", out reasonCode)) return false;
        if (!this.actionRouter.IsOnOwnerThread) { reasonCode = "game_thread_required"; return false; }

        string operation = envelope!.Payload.Operation;
        if (operation != "inspect_world_map" || !this.capabilityPublicationProvider().CapabilitySet.AllowsReadOperation(operation))
        { reasonCode = "operation_not_available"; return false; }

        DerivedDestinationSet? set = this.navigationSetProvider();
        if (set is null) { reasonCode = "world_map_unavailable"; return false; }

        var context = new NavigationBindingContext(
            this.navigationRuntimeInstanceId,
            this.scope,
            set.Generation,
            ++this.navigationObservationSequence,
            DateTimeOffset.UtcNow);
        BridgeNavigationReadArgs args = envelope.Payload.Args;
        WorldMapProjection projection = new(this.navigationReferences);
        WorldMapProjectionResult result = args.NodeRef is not null && args.Cursor is null
            ? projection.ProjectNode(set, args.NodeRef, context)
            : args.Cursor is not null && args.NodeRef is null
                ? projection.ProjectCursor(set, args.Cursor, context)
                : args.NodeRef is null && args.Cursor is null
                    ? projection.ProjectRoot(set, context)
                    : WorldMapProjectionResult.Blocked("world_map_unavailable");
        BridgeNavigationReadResult payload = result.BlockedReason is null
            ? new BridgeNavigationReadResult(
                "succeeded",
                "world_map_observed",
                result.Entries!.Select(entry => new BridgeWorldMapEntry(
                    entry.Label,
                    entry.ContextLabel,
                    entry.NodeRef,
                    entry.Destination is null ? null : ToBridgeSelector(entry.Destination))).ToArray(),
                result.NextCursor)
            : new BridgeNavigationReadResult("blocked", result.BlockedReason, null, null);
        response = Reply("navigation_read_result", envelope.CorrelationId, payload);
        reasonCode = "accepted";
        return true;
    }

    private static BridgeNavigationDestinationSelector ToBridgeSelector(NavigationDestinationSelector selector) =>
        new(selector.Kind, selector.Label, selector.Ref);

    internal void ClearNavigationForWorldUnload() => this.navigationReferences.ClearForWorldUnload();

    internal bool TryExecute(long generation, BridgeEnvelope<BridgeExecutionRequest>? envelope, out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "execution_request", out reasonCode)) return false;
        BridgeExecutionRequest request = envelope!.Payload;
        if (!IsStructurallyValidExecutionRequest(request, out reasonCode)) return false;
        string fingerprint = request.Action == "navigate_to_destination"
            ? $"{request.RequestId}:{request.Action}:{request.Args.Destination?.Kind}:{request.Args.Destination?.Label}:{request.Args.Destination?.Ref}:{request.ExpectedRevision}"
            : $"{request.RequestId}:{request.Action}:{request.Args.X}:{request.Args.Y}:{request.Args.Slot}:{request.Args.ExpectedQualifiedItemId}:{request.Args.ExpectedTargetId}:{request.ExpectedRevision}";
        // Replays return a durable receipt but remain current bridge requests:
        // they must satisfy the same owner-thread, published-capability, revision,
        // and deadline gates before the ledger is consulted.
        if (!this.actionRouter.IsOnOwnerThread) { reasonCode = "game_thread_required"; return false; }
        if (!this.capabilityPublicationProvider().CapabilitySet.AllowsExecutionAction(request.Action)) { reasonCode = "action_not_available"; return false; }
        if (!IsFreshExecutionRequest(request, out reasonCode)) return false;
        if (this.idempotency.TryGetValue(request.IdempotencyKey, out IdempotentExecution? existing))
        {
            if (existing.Fingerprint != fingerprint) { reasonCode = "idempotency_key_conflict"; return false; }
            if (!this.executions.TryGetReceipt(existing.RequestId, out LocalExecutionReceipt latest)) { reasonCode = "idempotency_receipt_unavailable"; return false; }
            if (!TryToBridgeReceipt(latest, out BridgeReceipt replayReceipt)) { reasonCode = "receipt_lineage_unavailable"; return false; }
            response = Reply("execution_receipt", envelope.CorrelationId, replayReceipt); reasonCode = "idempotent_replay"; return true;
        }
        IdempotentExecution? existingRequest = this.idempotency.Values.FirstOrDefault(candidate => candidate.RequestId == request.RequestId);
        if (existingRequest is not null)
        {
            if (existingRequest.Fingerprint != fingerprint) { reasonCode = "request_id_conflict"; return false; }
            if (!this.executions.TryGetReceipt(existingRequest.RequestId, out LocalExecutionReceipt latest)) { reasonCode = "idempotency_receipt_unavailable"; return false; }
            if (!TryToBridgeReceipt(latest, out BridgeReceipt replayReceipt)) { reasonCode = "receipt_lineage_unavailable"; return false; }
            response = Reply("execution_receipt", envelope.CorrelationId, replayReceipt); reasonCode = "idempotent_replay"; return true;
        }
        // Bind immutable request/action lineage before routing because a handler
        // may synchronously publish its first receipt.
        RememberIdempotency(request.IdempotencyKey, fingerprint, request.RequestId, request.Action);
        if (!this.actionRouter.TryRoute(request, this.executions, out LocalExecutionReceipt receipt, out reasonCode))
        {
            ForgetIdempotency(request.IdempotencyKey);
            return false;
        }
        if (!TryToBridgeReceipt(receipt, out BridgeReceipt bridgeReceipt)) { reasonCode = "receipt_lineage_unavailable"; return false; }
        response = Reply("execution_receipt", envelope.CorrelationId, bridgeReceipt); reasonCode = "accepted"; return true;
    }

    /// <summary>
    /// Authenticated read-only exact receipt recovery. The query carries only
    /// the original dispatch tuple (requestId, idempotencyKey) because the Host
    /// may not yet know the Mod-generated executionId when the first response or
    /// a terminal receipt was lost. It never routes an action, never creates an
    /// execution, never cancels, never changes revision, never publishes a
    /// receipt callback, and does not require current capability, revision, or
    /// deadline. It fails closed in frozen order: authenticated current
    /// generation -> exact envelope/scope/timestamp -> game thread -> exact
    /// {requestId,idempotencyKey} -> durable ledger receipt lookup. The bounded
    /// idempotency cache is consulted only as an identity cross-check while its
    /// binding is still remembered; an evicted binding never hides a terminal
    /// receipt that the action-owned ledger still holds.
    /// </summary>
    internal bool TryQueryExecutionReceipt(
        long generation,
        BridgeEnvelope<BridgeExecutionReceiptQuery>? envelope,
        out BridgeEnvelope<BridgeReceipt>? response,
        out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "execution_receipt_query", out reasonCode)) return false;
        // Historical read-only recovery is still a current bridge request: it
        // satisfies the same owner-thread gate as execution and cancel requests
        // before any ledger state is consulted.
        if (!this.actionRouter.IsOnOwnerThread) { reasonCode = "game_thread_required"; return false; }
        BridgeExecutionReceiptQuery query = envelope!.Payload;
        if (!BridgeProtocol.IsOpaqueId(query.RequestId) || !BridgeProtocol.IsOpaqueId(query.IdempotencyKey))
        { reasonCode = "invalid_execution_receipt_query"; return false; }
        // The exact tuple is verified only while the immutable binding is still
        // remembered. Eviction is not lineage loss: the ledger receipt owns
        // requestId and actionId independently of this bounded cache.
        if (this.idempotency.TryGetValue(query.IdempotencyKey, out IdempotentExecution? binding)
            && !string.Equals(binding.RequestId, query.RequestId, StringComparison.Ordinal))
        { reasonCode = "idempotency_key_conflict"; return false; }
        if (!this.executions.TryGetReceipt(query.RequestId, out LocalExecutionReceipt receipt)
            || !string.Equals(receipt.RequestId, query.RequestId, StringComparison.Ordinal))
        {
            // The receipt is unknown. A requestId still bound under a different
            // remembered key is an identity conflict, never a silent read.
            bool requestBoundElsewhere = this.idempotency.Values.Any(candidate =>
                string.Equals(candidate.RequestId, query.RequestId, StringComparison.Ordinal));
            reasonCode = requestBoundElsewhere ? "idempotency_key_conflict" : "receipt_not_found";
            return false;
        }
        // Solicited read-only response correlated to the query envelope. No
        // RememberIdempotency, no route, no cancel, no callback, no revision.
        if (!TryToBridgeReceipt(receipt, out BridgeReceipt bridgeReceipt))
        { reasonCode = "receipt_lineage_unavailable"; return false; }
        response = Reply("execution_receipt", envelope.CorrelationId, bridgeReceipt);
        reasonCode = "accepted";
        return true;
    }

    /// <summary>Publishes one complete newer availability replacement for this authenticated generation.</summary>
    internal bool TryCreateCatalogUpdate(long generation, long previouslyPublishedRevision, string correlationId, out string json)
    {
        json = string.Empty;
        FarmhandCapabilityPublication publication = this.capabilityPublicationProvider();
        if (!IsAuthenticated(generation, out _)
            || publication.CapabilityRevision <= previouslyPublishedRevision
            || !BridgeProtocol.IsOpaqueId(correlationId))
            return false;
        return BridgeProtocol.TrySerialize(Reply("catalog_update", correlationId,
            new BridgeCatalogUpdate(publication.CapabilityRevision, publication.EnabledActionIds)), out json, out _);
    }

    internal long CurrentCatalogRevision => this.capabilityPublicationProvider().CapabilityRevision;

    internal bool TryCreateReceiptEvent(long generation, LocalExecutionReceipt receipt, out string json)
    {
        json = string.Empty;
        return IsAuthenticated(generation, out _)
            && TryToBridgeReceipt(receipt, out BridgeReceipt bridgeReceipt)
            && BridgeProtocol.TrySerialize(Reply("execution_receipt", receipt.RequestId, bridgeReceipt), out json, out _);
    }

    internal bool TryCreateSemanticEvent(long generation, string kind, string correlationId, string reasonCode, out string json)
        => this.TryCreateSemanticEvent(generation, kind, correlationId, reasonCode, null, out json);

    internal bool TryCreateBodyTraceEvent(long generation, ExecutionTrace trace, string correlationId, out string json)
    {
        // A body trace is published only through the typed semantic-event
        // channel. Its category is the event kind, so remote consumers can
        // reject a mismatched envelope before treating it as lifecycle proof.
        if (!IsBodyTraceCategory(trace.Category) || this.IsNavigationTrace(trace))
        {
            json = string.Empty;
            return false;
        }
        BridgeBodyTrace bodyTrace = new(trace.Category, trace.ExecutionId, trace.RequestId, trace.Tick, trace.Revision,
            trace.Location, trace.ActorTile is Vector2 tile ? new BridgeTile(tile.X, tile.Y) : null);
        return this.TryCreateSemanticEvent(generation, trace.Category, correlationId, "body_trace", bodyTrace, out json);
    }

    private static bool IsBodyTraceCategory(string category) => category is
        "execution_started" or
        "route_progress" or
        "execution_settled_succeeded" or
        "execution_settled_cancelled" or
        "execution_settled_failed" or
        "execution_invalidated" or
        "body_idle";

    // Defense in depth for the manager's no-trace Navigation policy. A direct
    // caller must not serialize a synthetic navigation trace with a live
    // location/tile after the ledger has bound that request to Navigation.
    private bool IsNavigationTrace(ExecutionTrace trace) =>
        this.executions.TryGetReceipt(trace.RequestId, out LocalExecutionReceipt receipt)
        && string.Equals(receipt.ExecutionId, trace.ExecutionId, StringComparison.Ordinal)
        && string.Equals(receipt.ActionId, "navigate_to_destination", StringComparison.Ordinal);

    private bool TryCreateSemanticEvent(long generation, string kind, string correlationId, string reasonCode, BridgeBodyTrace? bodyTrace, out string json)
    {
        json = string.Empty;
        if (!IsAuthenticated(generation, out _) || !BridgeProtocol.IsOpaqueId(correlationId) || !BridgeProtocol.IsReasonCode(reasonCode)) return false;
        BridgeActiveExecution? active = this.executions.CreateBridgeSnapshot().ActiveExecution;
        return BridgeProtocol.TrySerialize(Reply("semantic_event", correlationId, new BridgeSemanticEvent(kind, this.executions.Revision, active, reasonCode, bodyTrace)), out json, out _);
    }

    internal bool TryCreatePlayerControlEvent(long generation, BridgePlayerControlFact control, string correlationId, out string json)
    {
        json = string.Empty;
        if (!IsAuthenticated(generation, out _)
            || !BridgeProtocol.IsOpaqueId(correlationId)
            || control.Kind is not (PlayerControlProtocol.PlayerInput or PlayerControlProtocol.StopAll)
            || !BridgeProtocol.IsOpaqueId(control.ControlId)
            || !BridgeProtocol.IsOpaqueId(control.SourceEventId)
            || !BridgeProtocol.IsOpaqueId(control.IssuerPlayerId)
            || control.Locale.Length is < 2 or > 64
            || (control.Kind == PlayerControlProtocol.PlayerInput && (string.IsNullOrWhiteSpace(control.Text) || control.Text.Length > PlayerControlProtocol.MaximumTextLength))
            || (control.Kind == PlayerControlProtocol.StopAll && control.Text is not null))
            return false;
        if (this.pendingPlayerControls.ContainsKey(control.ControlId)
            || this.pendingPlayerControls.Count >= MaximumPendingPlayerControls)
            return false;
        BridgeActiveExecution? active = this.executions.CreateBridgeSnapshot().ActiveExecution;
        if (!BridgeProtocol.TrySerialize(Reply("semantic_event", correlationId,
            new BridgeSemanticEvent(control.Kind, this.executions.Revision, active, "player_control", PlayerControl: control)), out json, out _))
            return false;
        this.pendingPlayerControls.Add(control.ControlId, control.SourceEventId);
        return true;
    }

    /// <summary>
    /// Removes a reservation only when its frame could not enter this same
    /// authenticated connection's outbound queue. Writer completion is not an
    /// admission failure and remains pending because it may have reached Host.
    /// </summary>
    internal bool TryAbandonPlayerControl(long generation, string controlId, string sourceEventId)
    {
        return IsAuthenticated(generation, out _)
            && BridgeProtocol.IsOpaqueId(controlId)
            && BridgeProtocol.IsOpaqueId(sourceEventId)
            && this.pendingPlayerControls.TryGetValue(controlId, out string? pendingSourceEventId)
            && FixedEquals(pendingSourceEventId, sourceEventId)
            && this.pendingPlayerControls.Remove(controlId);
    }

    internal bool TryAcceptPlayerControlReceipt(
        long generation,
        BridgeEnvelope<BridgePlayerControlReceipt>? envelope,
        out string reasonCode)
    {
        if (!IsAuthenticated(generation, out reasonCode)
            || !IsValidEnvelope(envelope, "player_control_receipt", out reasonCode))
            return false;
        BridgePlayerControlReceipt receipt = envelope!.Payload;
        if (receipt.Status != "accepted"
            || !BridgeProtocol.IsOpaqueId(receipt.ControlId)
            || !BridgeProtocol.IsOpaqueId(receipt.SourceEventId)
            || !this.pendingPlayerControls.TryGetValue(receipt.ControlId, out string? sourceEventId)
            || !FixedEquals(sourceEventId, receipt.SourceEventId))
        {
            reasonCode = "invalid_player_control_receipt";
            return false;
        }
        this.pendingPlayerControls.Remove(receipt.ControlId);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryCreateStopBodySettledEvent(long generation, BridgeStopObservation observation, string correlationId, out string json)
    {
        json = string.Empty;
        if (!IsAuthenticated(generation, out _)
            || !BridgeProtocol.IsOpaqueId(correlationId)
            || observation.Kind != "body_settled"
            || !BridgeProtocol.IsOpaqueId(observation.StopId)
            || !BridgeProtocol.IsOpaqueId(observation.SourceEventId)
            || observation.Epoch < 1)
            return false;
        BridgeSnapshot snapshot = this.executions.CreateBridgeSnapshot();
        if (snapshot.ActiveExecution is not null)
            return false;
        return BridgeProtocol.TrySerialize(Reply("semantic_event", correlationId,
            new BridgeSemanticEvent("body_settled", snapshot.Revision, null, "stop_body_settled", StopObservation: observation)), out json, out _);
    }

    internal bool TryCreateLifecycleEvent(long generation, string state, string correlationId, string reasonCode, out string json)
    {
        json = string.Empty;
        if (!IsAuthenticated(generation, out _) || !BridgeProtocol.IsOpaqueId(correlationId) || !BridgeProtocol.IsReasonCode(reasonCode) || state is not ("connected" or "disconnected" or "world_unavailable")) return false;
        return BridgeProtocol.TrySerialize(Reply("lifecycle", correlationId, new BridgeLifecycle(state, reasonCode)), out json, out _);
    }

    internal void AdvancePresentationEpoch() => this.presentationEpoch++;

    internal bool TryPresentCompanionText(
        long generation,
        BridgeEnvelope<BridgeCompanionPresentationRequest>? envelope,
        Func<BridgeCompanionPresentationRequest, bool> present,
        out BridgeEnvelope<BridgeCompanionPresentationReceipt>? response,
        out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "companion_presentation_request", out reasonCode)) return false;
        BridgeCompanionPresentationRequest request = envelope!.Payload;
        string fingerprint = $"{request.SourceEventId}\n{request.Text}\n{request.Locale}\n{request.ExpectedRevision}\n{request.PresentationEpoch}";
        if (this.presentations.TryGetValue(request.ExpressionId, out IdempotentPresentation? existing))
        {
            if (existing.Fingerprint != fingerprint) { reasonCode = "companion_presentation_expression_conflict"; return false; }
            if (existing.Receipt is null)
            {
                // The sender was unavailable or threw after possibly emitting
                // native chat. Replay must preserve that terminal failure, not
                // acknowledge a presentation that never succeeded.
                reasonCode = existing.ReasonCode;
                return false;
            }
            response = Reply("companion_presentation_receipt", envelope.CorrelationId, existing.Receipt);
            reasonCode = "companion_presentation_replay";
            return true;
        }
        if (!TryCurrentPresentationLocale(out string locale)
            || !BridgeProtocol.IsOpaqueId(request.ExpressionId) || !BridgeProtocol.IsOpaqueId(request.SourceEventId)
            || string.IsNullOrWhiteSpace(request.Text) || request.Text.Length > 4_000
            || request.Locale != locale
            || request.ExpectedRevision != this.executions.Revision
            || request.PresentationEpoch != this.presentationEpoch)
        { reasonCode = "invalid_or_stale_companion_presentation"; return false; }
        // Terminalize before the native side effect. A throwing sender can have
        // sent chat before reporting failure; replay must never send twice.
        this.presentations.Add(request.ExpressionId, new(fingerprint, null, "companion_presentation_send_failed"));
        try
        {
            if (!present(request))
            {
                this.presentations[request.ExpressionId] = new(fingerprint, null, "companion_presentation_target_unavailable");
                reasonCode = "companion_presentation_target_unavailable";
                return false;
            }
        }
        catch
        {
            reasonCode = "companion_presentation_send_failed";
            return false;
        }
        BridgeCompanionPresentationReceipt receipt = new(request.ExpressionId, this.executions.Revision, this.presentationEpoch);
        this.presentations[request.ExpressionId] = new(fingerprint, receipt, "accepted");
        response = Reply("companion_presentation_receipt", envelope.CorrelationId, receipt);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryPresentSystemNotice(
        long generation,
        BridgeEnvelope<BridgeSystemNoticeRequest>? envelope,
        Func<BridgeSystemNoticeRequest, bool> present,
        out BridgeEnvelope<BridgeSystemNoticeReceipt>? response,
        out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "system_notice_request", out reasonCode)) return false;
        BridgeSystemNoticeRequest request = envelope!.Payload;
        string fingerprint = $"{request.Key}\n{request.Text}\n{request.Locale}";
        if (this.systemNotices.TryGetValue(request.NoticeId, out IdempotentSystemNotice? existing))
        {
            if (existing.Fingerprint != fingerprint) { reasonCode = "system_notice_conflict"; return false; }
            if (existing.Receipt is null) { reasonCode = existing.ReasonCode; return false; }
            response = Reply("system_notice_receipt", envelope.CorrelationId, existing.Receipt);
            reasonCode = "system_notice_replay";
            return true;
        }
        if (!TryCurrentPresentationLocale(out string locale)
            || !BridgeProtocol.IsOpaqueId(request.NoticeId)
            || !IsValidSystemNoticeCopy(request, locale))
        { reasonCode = "invalid_system_notice"; return false; }
        // Terminalize before calling native chat: sender exceptions can happen
        // after their side effect, so replays must retain this failure.
        this.systemNotices.Add(request.NoticeId, new(fingerprint, null, "system_notice_send_failed"));
        try
        {
            if (!present(request))
            {
                this.systemNotices[request.NoticeId] = new(fingerprint, null, "system_notice_target_unavailable");
                reasonCode = "system_notice_target_unavailable";
                return false;
            }
        }
        catch
        {
            reasonCode = "system_notice_send_failed";
            return false;
        }
        BridgeSystemNoticeReceipt receipt = new(request.NoticeId, this.executions.Revision);
        this.systemNotices[request.NoticeId] = new(fingerprint, receipt, "accepted");
        response = Reply("system_notice_receipt", envelope.CorrelationId, receipt);
        reasonCode = "accepted";
        return true;
    }

    private static bool IsValidSystemNoticeCopy(BridgeSystemNoticeRequest request, string locale)
    {
        if (string.IsNullOrWhiteSpace(request.Text) || request.Text.Length > 256 || request.Locale != locale)
            return false;
        bool simplifiedChinesePreview = locale.Equals("zh-CN", StringComparison.Ordinal);
        return request.Key switch
        {
            "system.stop.active_turn_cancelled" => request.Text == (simplifiedChinesePreview ? "已停止生成。" : "Generation stopped."),
            "system.stop.queued_turn_cancelled" => request.Text == (simplifiedChinesePreview ? "已停止生成。" : "Generation stopped."),
            "system.stop.no_active_turn" => request.Text == (simplifiedChinesePreview ? "当前没有正在生成的回复。" : "No reply is currently being generated."),
            _ => false,
        };
    }

    internal bool TryCancel(long generation, BridgeEnvelope<BridgeCancelRequest>? envelope, out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "cancel_request", out reasonCode)) return false;
        BridgeCancelRequest request = envelope!.Payload;
        // The typed cancel identity tuple must bind request, execution, cancel
        // epoch/identifier, and current state before the action-owned ledger
        // converges; a missing, stale, or mismatched identity is rejected
        // without cancelling a different execution.
        if (!BridgeProtocol.IsOpaqueId(request.RequestId)
            || !BridgeProtocol.IsOpaqueId(request.ExecutionId)
            || !BridgeProtocol.IsOpaqueId(request.CancelId)
            || request.CancelEpoch < 1
            || !BridgeProtocol.IsReasonCode(request.ReasonCode))
        { reasonCode = "invalid_cancel_request"; return false; }
        // Cancels — including exact receipt-replay cancels — remain current
        // bridge requests: they must satisfy the same owner-thread gate as
        // execution requests before the remembered cancel identity or the
        // action-owned ledger is consulted.
        if (!this.actionRouter.IsOnOwnerThread) { reasonCode = "game_thread_required"; return false; }
        if (!this.TryValidateCancelIdentity(request, out reasonCode)) return false;
        LocalExecutionReceipt receipt = this.executions.Cancel(request.RequestId, request.ExecutionId, request.ReasonCode);
        // Bind the identity only when the ledger actually converged the exact
        // execution. Rejections stay unrecorded so a later exact cancel for a
        // different execution is never blocked by a stale identity.
        if (receipt.State != ExecutionState.Rejected)
            this.RememberCancelIdentity(request.RequestId, new CancelIdentityRecord(request.ExecutionId, request.CancelId, request.CancelEpoch));
        if (!TryToBridgeReceipt(receipt, out BridgeReceipt bridgeReceipt))
        { reasonCode = "receipt_lineage_unavailable"; return false; }
        response = Reply("execution_receipt", envelope.CorrelationId, bridgeReceipt);
        reasonCode = "accepted";
        return true;
    }

    private bool TryValidateCancelIdentity(BridgeCancelRequest request, out string reasonCode)
    {
        if (this.cancelIdentities.TryGetValue(request.RequestId, out CancelIdentityRecord? existing))
        {
            if (!string.Equals(existing.ExecutionId, request.ExecutionId, StringComparison.Ordinal)
                || !string.Equals(existing.CancelId, request.CancelId, StringComparison.Ordinal))
            { reasonCode = "cancel_identity_mismatch"; return false; }
            if (request.CancelEpoch < existing.CancelEpoch)
            { reasonCode = "stale_cancel"; return false; }
            if (request.CancelEpoch > existing.CancelEpoch)
                this.cancelIdentities[request.RequestId] = existing with { CancelEpoch = request.CancelEpoch };
        }
        reasonCode = "accepted";
        return true;
    }

    private void RememberCancelIdentity(string requestId, CancelIdentityRecord record)
    {
        if (this.cancelIdentities.TryGetValue(requestId, out CancelIdentityRecord? existing)
            && existing.CancelEpoch >= record.CancelEpoch)
            return;
        this.cancelIdentities[requestId] = record;
        this.cancelIdentityOrder.Enqueue(requestId);
        while (this.cancelIdentityOrder.Count > MaximumRememberedCancelIdentities)
            this.cancelIdentities.Remove(this.cancelIdentityOrder.Dequeue());
    }

    private bool IsAuthenticated(long generation, out string reasonCode)
    {
        if (this.authenticatedGeneration != generation) { reasonCode = "unauthenticated"; return false; }
        reasonCode = "accepted";
        return true;
    }
    private bool TryCurrentPresentationLocale(out string locale)
    {
        try
        {
            locale = this.presentationLocale();
            return NativeChatPresentationPolicy.IsValidBcp47Locale(locale);
        }
        catch
        {
            locale = string.Empty;
            return false;
        }
    }
    private static bool IsStructurallyValidExecutionRequest(BridgeExecutionRequest? request, out string reasonCode)
    {
        if (request is null || !BridgeProtocol.IsOpaqueId(request.RequestId) || !BridgeProtocol.IsOpaqueId(request.IdempotencyKey) || request.Args is null || !HasExactArgumentShape(request.Action, request.Args))
        { reasonCode = "invalid_execution_request"; return false; }
        if (request.Action is "move_to_tile" or "enter_exit" or "travel" or "till_soil")
        {
            if (!request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000)
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action is "pickup_forage" or "pickup_item")
        {
            if (!request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || request.Args.ExpectedQualifiedItemId is not { Length: > 0 and <= 128 } || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action is "water_crop" or "harvest_crop")
        {
            if (!request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId) || (request.Action == "harvest_crop" && request.Args.ExpectedQualifiedItemId is not { Length: > 0 and <= 128 }))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action is "plant_seed" or "fertilize_tile" or "place_wood_fence" or "place_crab_pot" or "bait_crab_pot")
        {
            if (request.Args.AdditionalProperties is { Count: > 0 } || !request.Args.Slot.HasValue || request.Args.Slot.Value < 0 || request.Args.Slot.Value > 36 || !request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || request.Args.ExpectedQualifiedItemId is not { Length: > 0 and <= 128 } || (request.Action == "place_wood_fence" && request.Args.ExpectedQualifiedItemId != "(O)322") || (request.Action == "place_crab_pot" && request.Args.ExpectedQualifiedItemId != "(O)710") || (request.Action == "bait_crab_pot" && request.Args.ExpectedQualifiedItemId != "(O)685") || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action == "clear_debris")
        {
            if (!request.Args.Slot.HasValue || request.Args.Slot.Value < 0 || request.Args.Slot.Value > 36 || !request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action == "machine_inspect")
        {
            if (!request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action == "machine_load")
        {
            if (request.Args.AdditionalProperties is { Count: > 0 } || !request.Args.Slot.HasValue || request.Args.Slot.Value < 0 || request.Args.Slot.Value > 36 || !request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || request.Args.ExpectedQualifiedItemId != "(O)433" || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action == "machine_collect_output")
        {
            if (request.Args.AdditionalProperties is { Count: > 0 } || request.Args.Slot.HasValue || request.Args.ExpectedQualifiedItemId is not null || !request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action is "npc_relationship" or "pet_animal")
        {
            if (!request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value < 0 || request.Args.Y.Value > 1000 || request.Args.X.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action is "collect_animal_product" or "feed_animal")
        {
            if (!request.Args.Slot.HasValue || request.Args.Slot.Value < 0 || request.Args.Slot.Value > 36 || !request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action == "use_item")
        {
            if (!request.Args.Slot.HasValue || request.Args.Slot.Value < 0 || request.Args.Slot.Value > 36 || request.Args.ExpectedQualifiedItemId is not { Length: > 0 and <= 128 })
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action == "navigate_to_destination")
        {
            if (!NavigationDestinationSelector.TryCreateFromWire(request.Args.Destination, out _))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action is "refill_watering_can" or "chop_tree_source" or "break_rock_source")
        {
            if (request.Args.AdditionalProperties is { Count: > 0 } || !request.Args.Slot.HasValue || request.Args.Slot.Value < 0 || request.Args.Slot.Value > 36 || !request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action is "clear_hoedirt" or "dig_artifact_spot")
        {
            if (request.Args.AdditionalProperties is { Count: > 0 } || request.Args.ExpectedQualifiedItemId is not null || !request.Args.Slot.HasValue || request.Args.Slot.Value < 0 || request.Args.Slot.Value > 36 || !request.Args.X.HasValue || !request.Args.Y.HasValue || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value) || request.Args.X.Value != MathF.Floor(request.Args.X.Value) || request.Args.Y.Value != MathF.Floor(request.Args.Y.Value) || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000 || !BridgeProtocol.IsOpaqueId(request.Args.ExpectedTargetId))
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else if (request.Action == "equip_tool")
        {
            if (!request.Args.Slot.HasValue || request.Args.Slot.Value < 0 || request.Args.Slot.Value > 36)
            { reasonCode = "invalid_execution_request"; return false; }
        }
        else
        { reasonCode = "invalid_execution_request"; return false; }
        reasonCode = "accepted"; return true;
    }

    private static bool HasExactArgumentShape(string action, BridgeExecutionArgs args)
    {
        if (args.AdditionalProperties is { Count: > 0 }) return false;
        bool x = args.X.HasValue;
        bool y = args.Y.HasValue;
        bool slot = args.Slot.HasValue;
        bool qualifiedItem = args.ExpectedQualifiedItemId is not null;
        bool target = args.ExpectedTargetId is not null;
        if (action == "navigate_to_destination")
            return args.Destination is not null && !x && !y && !slot && !qualifiedItem && !target;
        return action switch
        {
            "move_to_tile" or "travel" or "enter_exit" or "till_soil" => x && y && !slot && !qualifiedItem && !target,
            "equip_tool" => !x && !y && slot && !qualifiedItem && !target,
            "pickup_forage" or "pickup_item" or "harvest_crop" => x && y && !slot && qualifiedItem && target,
            "water_crop" or "machine_inspect" or "machine_collect_output" or "npc_relationship" or "pet_animal" => x && y && !slot && !qualifiedItem && target,
            "plant_seed" or "fertilize_tile" or "place_wood_fence" or "place_crab_pot" or "bait_crab_pot" or "machine_load" => x && y && slot && qualifiedItem && target,
            "clear_debris" or "collect_animal_product" or "feed_animal" or "refill_watering_can" or "chop_tree_source" or "break_rock_source" or "clear_hoedirt" or "dig_artifact_spot" => x && y && slot && !qualifiedItem && target,
            "use_item" => !x && !y && slot && qualifiedItem && !target,
            _ => false,
        };
    }

    private bool IsFreshExecutionRequest(BridgeExecutionRequest request, out string reasonCode)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (request.ExpectedRevision != this.executions.Revision) { reasonCode = "stale_snapshot"; return false; }
        if (request.DeadlineMs < nowMs || request.DeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds) { reasonCode = "invalid_deadline"; return false; }
        reasonCode = "accepted"; return true;
    }
    private bool IsValidEnvelope<TPayload>(BridgeEnvelope<TPayload>? envelope, string expectedType, out string reasonCode)
    {
        if (envelope is null || envelope.Scope is null || envelope.Payload is null || envelope.ProtocolVersion != BridgeProtocol.Version || envelope.Type != expectedType || !BridgeProtocol.IsOpaqueId(envelope.MessageId) || !BridgeProtocol.IsOpaqueId(envelope.CorrelationId) || !envelope.Scope.Equals(this.scope)) { reasonCode = "invalid_envelope"; return false; }
        if (Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - envelope.TimestampMs) > TimeSpan.FromMinutes(5).TotalMilliseconds) { reasonCode = "stale_or_invalid_timestamp"; return false; }
        reasonCode = "accepted"; return true;
    }
    private void RememberIdempotency(string key, string fingerprint, string requestId, string actionId)
    {
        this.idempotency[key] = new(fingerprint, requestId, actionId);
        this.idempotencyOrder.Enqueue(key);
        if (this.idempotencyOrder.Count > MaximumRememberedIdempotencyKeys)
            this.idempotency.Remove(this.idempotencyOrder.Dequeue());
    }

    private void ForgetIdempotency(string key) => this.idempotency.Remove(key);

    private bool TryToBridgeReceipt(LocalExecutionReceipt receipt, out BridgeReceipt bridgeReceipt)
    {
        bridgeReceipt = default!;
        IdempotentExecution? binding = this.idempotency.Values.FirstOrDefault(candidate =>
            string.Equals(candidate.RequestId, receipt.RequestId, StringComparison.Ordinal));
        if (binding is null
            || !BridgeProtocol.IsOpaqueId(binding.ActionId)
            || !BridgeProtocol.IsOpaqueId(receipt.ExecutionId)
            || !BridgeProtocol.IsOpaqueId(receipt.RequestId))
            return false;
        bridgeReceipt = new BridgeReceipt(
            receipt.ExecutionId,
            receipt.RequestId,
            binding.ActionId,
            receipt.State.ToWireValue(),
            receipt.ReasonCode,
            receipt.Revision,
            receipt.Evidence is null ? null : new Dictionary<string, string> { ["detail"] = receipt.Evidence });
        return true;
    }

    internal bool IsAuthenticatedGeneration(long generation) => IsAuthenticated(generation, out _);
    internal BridgeEnvelope<BridgeError> CreateError(string? correlationId, string reasonCode) => Reply("error", BridgeProtocol.IsOpaqueId(correlationId) ? correlationId! : Guid.NewGuid().ToString("N"), new BridgeError(reasonCode));
    private BridgeEnvelope<TPayload> Reply<TPayload>(string type, string correlationId, TPayload payload) => new(BridgeProtocol.Version, Guid.NewGuid().ToString("N"), correlationId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), this.scope, type, payload);
    private static bool FixedEquals(string? left, string right) => CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(left ?? string.Empty), System.Text.Encoding.UTF8.GetBytes(right));
}

internal sealed record IdempotentExecution(string Fingerprint, string RequestId, string ActionId);
internal sealed record IdempotentPresentation(string Fingerprint, BridgeCompanionPresentationReceipt? Receipt, string ReasonCode);
internal sealed record IdempotentSystemNotice(string Fingerprint, BridgeSystemNoticeReceipt? Receipt, string ReasonCode);
internal sealed record BridgeHello(string Token);
internal sealed record BridgeHelloAck(string SessionId, IReadOnlyList<string> Capabilities, long CatalogRevision, IReadOnlyList<string> EnabledActionIds, string PresentationLocale, IReadOnlyList<FarmhandActionRegistrationWire> Registrations, string RuntimeRole, string? LaunchGeneration);
internal sealed record BridgeCatalogUpdate(long CatalogRevision, IReadOnlyList<string> EnabledActionIds);
internal sealed record BridgeObserveRequest();
internal sealed record BridgeCancelRequest(string RequestId, string ExecutionId, string CancelId, long CancelEpoch, string ReasonCode);
/// <summary>Last accepted cancel identity bound to one exact request/execution.</summary>
internal sealed record CancelIdentityRecord(string ExecutionId, string CancelId, long CancelEpoch);
internal sealed record BridgeCompanionPresentationRequest(string ExpressionId, string SourceEventId, string Text, string Locale, long ExpectedRevision, long PresentationEpoch);
internal sealed record BridgeCompanionPresentationReceipt(string ExpressionId, long Revision, long PresentationEpoch);
internal sealed record BridgeSystemNoticeRequest(string NoticeId, string Key, string Text, string Locale);
internal sealed record BridgeSystemNoticeReceipt(string NoticeId, long Revision);
internal sealed record BridgePlayerControlReceipt(string ControlId, string SourceEventId, string Status);
internal sealed record BridgeLifecycle(string State, string ReasonCode);
