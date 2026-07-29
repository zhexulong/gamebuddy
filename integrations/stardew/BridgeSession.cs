using System.Security.Cryptography;

namespace GameBuddy.Stardew;

/// <summary>Transport-neutral, SMAPI-game-thread-only authenticated session.</summary>
internal sealed class BridgeSession
{
    private const int MaximumRememberedIdempotencyKeys = 256;
    private const int MaximumOutstandingActionGrants = 8;
    private readonly ExecutionManager executions;
    private readonly BridgeScope scope;
    private readonly string token;
    private readonly Dictionary<string, IdempotentExecution> idempotency = new(StringComparer.Ordinal);
    private readonly Queue<string> idempotencyOrder = new();
    private readonly Dictionary<string, BridgeActionGrant> actionGrants = new(StringComparer.Ordinal);
    private long authenticatedGeneration = -1;

    internal BridgeSession(ExecutionManager executions, BridgeScope scope, string token)
    {
        this.executions = executions;
        this.scope = scope;
        this.token = token;
    }

    internal bool TryAuthenticate(long generation, BridgeEnvelope<BridgeHello>? envelope, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string reasonCode)
    {
        acknowledgement = null;
        if (!IsValidEnvelope(envelope, "hello", out reasonCode) || envelope!.Payload is null
            || !FixedEquals(envelope.Payload.Token, this.token))
        {
            reasonCode = "authentication_failed";
            return false;
        }
        if (this.authenticatedGeneration == generation)
        {
            reasonCode = "already_authenticated";
            return false;
        }
        // A new transport generation cannot inherit a prior connection's
        // player approval, even if it possesses the bridge credential.
        this.actionGrants.Clear();
        this.authenticatedGeneration = generation;
        // Authentication opens only this local transport. It does not mint
        // Game Action authority; approval must come from a separate local
        // player-policy boundary before an action can be exposed.
        // Capability declares a mechanically verified action surface; it is not
        // authority. No execution is accepted until a separate local policy
        // boundary mints a one-shot, target-bound approval grant.
        acknowledgement = Reply("hello_ack", envelope.CorrelationId, new BridgeHelloAck(Guid.NewGuid().ToString("N"), new[] { "move_to_tile", "inspect_self" }, Array.Empty<BridgeActionGrant>()));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryObserve(long generation, BridgeEnvelope<BridgeObserveRequest>? envelope, out BridgeEnvelope<BridgeSnapshot>? response, out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "observe_request", out reasonCode)) return false;
        response = Reply("snapshot", envelope!.CorrelationId, this.executions.CreateBridgeSnapshot());
        reasonCode = "accepted";
        return true;
    }

    internal bool TryExecute(long generation, BridgeEnvelope<BridgeExecutionRequest>? envelope, out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "execution_request", out reasonCode)) return false;
        BridgeExecutionRequest request = envelope!.Payload;
        // Validate enough shape to calculate the idempotency fingerprint, but
        // replay must not be rejected merely because the original deadline or
        // snapshot revision has since passed.
        if (!IsStructurallyValidExecutionRequest(request, out reasonCode)) return false;
        string fingerprint = $"{request.Action}:{request.Args.X}:{request.Args.Y}:{request.ExpectedRevision}";
        if (this.idempotency.TryGetValue(request.IdempotencyKey, out IdempotentExecution? existing))
        {
            if (existing.Fingerprint != fingerprint) { reasonCode = "idempotency_key_conflict"; return false; }
            if (!this.executions.TryGetReceipt(existing.RequestId, out LocalExecutionReceipt latest)) { reasonCode = "idempotency_receipt_unavailable"; return false; }
            response = Reply("execution_receipt", envelope.CorrelationId, ToBridgeReceipt(latest));
            reasonCode = "idempotent_replay";
            return true;
        }
        if (!IsFreshExecutionRequest(request, out reasonCode)) return false;
        if (!TryConsumeActionGrant(request, out reasonCode)) return false;

        LocalExecutionReceipt receipt = this.executions.RequestLocalMove(request.RequestId, new Microsoft.Xna.Framework.Vector2(request.Args.X!.Value, request.Args.Y!.Value));
        this.RememberIdempotency(request.IdempotencyKey, fingerprint, request.RequestId);
        response = Reply("execution_receipt", envelope.CorrelationId, ToBridgeReceipt(receipt));
        reasonCode = "accepted";
        return true;
    }

    /// <summary>Publishes a Mod-authoritative receipt only to the current authenticated pipe generation.</summary>
    internal bool TryCreateReceiptEvent(long generation, LocalExecutionReceipt receipt, out string json)
    {
        json = string.Empty;
        if (this.authenticatedGeneration != generation)
            return false;
        return BridgeProtocol.TrySerialize(Reply("execution_receipt", receipt.RequestId, ToBridgeReceipt(receipt)), out json, out _);
    }

    internal bool TryCreateActionGrantEvent(long generation, BridgeActionGrant grant, out string json)
    {
        json = string.Empty;
        if (this.authenticatedGeneration != generation)
            return false;
        return BridgeProtocol.TrySerialize(Reply("action_grant", grant.Nonce, grant), out json, out _);
    }

    internal bool TryCreateSemanticEvent(long generation, string kind, string correlationId, string reasonCode, out string json)
    {
        json = string.Empty;
        if (this.authenticatedGeneration != generation || !BridgeProtocol.IsOpaqueId(correlationId) || !BridgeProtocol.IsReasonCode(reasonCode))
            return false;
        BridgeActiveExecution? active = this.executions.CreateBridgeSnapshot().ActiveExecution;
        return BridgeProtocol.TrySerialize(Reply("semantic_event", correlationId, new BridgeSemanticEvent(kind, this.executions.Revision, active, reasonCode)), out json, out _);
    }

    internal bool TryCreateLifecycleEvent(long generation, string state, string correlationId, string reasonCode, out string json)
    {
        json = string.Empty;
        if (this.authenticatedGeneration != generation || !BridgeProtocol.IsOpaqueId(correlationId) || !BridgeProtocol.IsReasonCode(reasonCode)
            || state is not ("connected" or "disconnected" or "world_unavailable"))
            return false;
        return BridgeProtocol.TrySerialize(Reply("lifecycle", correlationId, new BridgeLifecycle(state, reasonCode)), out json, out _);
    }

    internal bool TryCancel(long generation, BridgeEnvelope<BridgeCancelRequest>? envelope, out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode)
    {
        response = null;
        if (!IsAuthenticated(generation, out reasonCode) || !IsValidEnvelope(envelope, "cancel_request", out reasonCode)) return false;
        BridgeCancelRequest request = envelope!.Payload;
        if (!BridgeProtocol.IsOpaqueId(request.RequestId) || !BridgeProtocol.IsOpaqueId(request.ExecutionId) || !BridgeProtocol.IsReasonCode(request.ReasonCode))
        { reasonCode = "invalid_cancel_request"; return false; }

        LocalExecutionReceipt receipt = this.executions.Cancel(request.RequestId, request.ExecutionId, request.ReasonCode);
        response = Reply("execution_receipt", envelope.CorrelationId, ToBridgeReceipt(receipt));
        reasonCode = "accepted";
        return true;
    }

    private bool IsAuthenticated(long generation, out string reasonCode)
    {
        if (this.authenticatedGeneration != generation) { reasonCode = "unauthenticated"; return false; }
        reasonCode = "accepted";
        return true;
    }

    private static bool IsStructurallyValidExecutionRequest(BridgeExecutionRequest? request, out string reasonCode)
    {
        if (request is null || !BridgeProtocol.IsOpaqueId(request.RequestId) || !BridgeProtocol.IsOpaqueId(request.IdempotencyKey)
            || request.Action != "move_to_tile" || request.Args is null || !request.Args.X.HasValue || !request.Args.Y.HasValue
            || !float.IsFinite(request.Args.X.Value) || !float.IsFinite(request.Args.Y.Value)
            || request.Args.X.Value < 0 || request.Args.Y.Value < 0 || request.Args.X.Value > 1000 || request.Args.Y.Value > 1000)
        { reasonCode = "invalid_execution_request"; return false; }
        reasonCode = "accepted";
        return true;
    }

    /// <summary>
    /// Called only by a local player-policy/UI boundary on the game thread.
    /// Transport authentication never calls this method, and grants are
    /// target-specific, short-lived, one-shot capabilities.
    /// </summary>
    internal bool TryApproveMoveToTile(long generation, float targetX, float targetY, out BridgeActionGrant? grant, out string reasonCode)
    {
        grant = null;
        if (!IsAuthenticated(generation, out reasonCode)) return false;
        if (!float.IsFinite(targetX) || !float.IsFinite(targetY) || targetX < 0 || targetY < 0 || targetX > 1000 || targetY > 1000)
        { reasonCode = "invalid_target_tile"; return false; }
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        this.PruneExpiredActionGrants(nowMs);
        if (this.actionGrants.Count >= MaximumOutstandingActionGrants)
        { reasonCode = "too_many_outstanding_approvals"; return false; }
        long expiresAtMs = nowMs + 30_000;
        grant = new BridgeActionGrant(Guid.NewGuid().ToString("N"), "move_to_tile", expiresAtMs, Guid.NewGuid().ToString("N"), targetX, targetY);
        this.actionGrants[grant.Token] = grant;
        reasonCode = "approved";
        return true;
    }

    private bool TryConsumeActionGrant(BridgeExecutionRequest request, out string reasonCode)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        this.PruneExpiredActionGrants(nowMs);
        if (!this.actionGrants.Remove(request.PermissionToken, out BridgeActionGrant? grant)
            || grant.Action != request.Action || grant.ExpiresAtMs < nowMs
            || !request.Args.X.HasValue || !request.Args.Y.HasValue || grant.TargetX != request.Args.X.Value || grant.TargetY != request.Args.Y.Value)
        { reasonCode = "action_not_player_approved"; return false; }
        reasonCode = "accepted";
        return true;
    }

    private void PruneExpiredActionGrants(long nowMs)
    {
        foreach (string token in this.actionGrants.Where(entry => entry.Value.ExpiresAtMs < nowMs).Select(entry => entry.Key).ToArray())
            this.actionGrants.Remove(token);
    }

    private bool IsFreshExecutionRequest(BridgeExecutionRequest request, out string reasonCode)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (request.ExpectedRevision != this.executions.Revision) { reasonCode = "stale_snapshot"; return false; }
        if (request.DeadlineMs < nowMs || request.DeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
        { reasonCode = "invalid_deadline"; return false; }
        reasonCode = "accepted";
        return true;
    }

    private bool IsValidEnvelope<TPayload>(BridgeEnvelope<TPayload>? envelope, string expectedType, out string reasonCode)
    {
        if (envelope is null || envelope.Scope is null || envelope.Payload is null || envelope.ProtocolVersion != BridgeProtocol.Version
            || envelope.Type != expectedType || !BridgeProtocol.IsOpaqueId(envelope.MessageId) || !BridgeProtocol.IsOpaqueId(envelope.CorrelationId)
            || !envelope.Scope.Equals(this.scope))
        { reasonCode = "invalid_envelope"; return false; }
        if (Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - envelope.TimestampMs) > TimeSpan.FromMinutes(5).TotalMilliseconds)
        { reasonCode = "stale_or_invalid_timestamp"; return false; }
        reasonCode = "accepted";
        return true;
    }

    private void RememberIdempotency(string key, string fingerprint, string requestId)
    {
        this.idempotency[key] = new(fingerprint, requestId);
        this.idempotencyOrder.Enqueue(key);
        if (this.idempotencyOrder.Count > MaximumRememberedIdempotencyKeys)
            this.idempotency.Remove(this.idempotencyOrder.Dequeue());
    }

    internal bool IsAuthenticatedGeneration(long generation) => this.authenticatedGeneration == generation;

    internal BridgeEnvelope<BridgeError> CreateError(string? correlationId, string reasonCode) => Reply(
        "error", BridgeProtocol.IsOpaqueId(correlationId) ? correlationId! : Guid.NewGuid().ToString("N"), new BridgeError(reasonCode));

    private BridgeEnvelope<TPayload> Reply<TPayload>(string type, string correlationId, TPayload payload) => new(
        BridgeProtocol.Version, Guid.NewGuid().ToString("N"), correlationId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), this.scope, type, payload);

    private static bool FixedEquals(string? left, string right) => CryptographicOperations.FixedTimeEquals(
        System.Text.Encoding.UTF8.GetBytes(left ?? string.Empty), System.Text.Encoding.UTF8.GetBytes(right));

    private static BridgeReceipt ToBridgeReceipt(LocalExecutionReceipt receipt) => new(receipt.ExecutionId, receipt.RequestId, receipt.State.ToWireValue(), receipt.ReasonCode, receipt.Revision,
        receipt.Evidence is null ? null : new Dictionary<string, string> { ["detail"] = receipt.Evidence });

}

internal sealed record IdempotentExecution(string Fingerprint, string RequestId);
internal sealed record BridgeHello(string Token);
internal sealed record BridgeActionGrant(string Token, string Action, long ExpiresAtMs, string Nonce, float TargetX, float TargetY);
internal sealed record BridgeHelloAck(string SessionId, IReadOnlyList<string> Capabilities, IReadOnlyList<BridgeActionGrant> ActionGrants);
internal sealed record BridgeObserveRequest();
internal sealed record BridgeCancelRequest(string RequestId, string ExecutionId, string ReasonCode);
internal sealed record BridgeLifecycle(string State, string ReasonCode);
