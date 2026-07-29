using System.Security.Cryptography;

namespace GameBuddy.Stardew;

/// <summary>Transport-neutral, SMAPI-game-thread-only authenticated session.</summary>
internal sealed class BridgeSession
{
    private const int MaximumRememberedIdempotencyKeys = 256;
    private readonly ExecutionManager executions;
    private readonly BridgeScope scope;
    private readonly string token;
    private readonly Dictionary<string, IdempotentExecution> idempotency = new(StringComparer.Ordinal);
    private readonly Queue<string> idempotencyOrder = new();
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
        this.authenticatedGeneration = generation;
        // Authentication opens only this local transport. It does not mint
        // Game Action authority; approval must come from a separate local
        // player-policy boundary before an action can be exposed.
        acknowledgement = Reply("hello_ack", envelope.CorrelationId, new BridgeHelloAck(Guid.NewGuid().ToString("N"), new[] { "inspect_self" }, Array.Empty<BridgeActionGrant>()));
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
        // A production approval boundary has not exposed move_to_tile yet.
        // Fail closed rather than treating a bridge credential as player consent.
        reasonCode = "action_not_player_approved";
        return false;
    }

    /// <summary>Publishes a Mod-authoritative receipt only to the current authenticated pipe generation.</summary>
    internal bool TryCreateReceiptEvent(long generation, LocalExecutionReceipt receipt, out string json)
    {
        json = string.Empty;
        if (this.authenticatedGeneration != generation)
            return false;
        return BridgeProtocol.TrySerialize(Reply("execution_receipt", receipt.RequestId, ToBridgeReceipt(receipt)), out json, out _);
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
internal sealed record BridgeActionGrant(string Token, string Action, long ExpiresAtMs, string Nonce);
internal sealed record BridgeHelloAck(string SessionId, IReadOnlyList<string> Capabilities, IReadOnlyList<BridgeActionGrant> ActionGrants);
internal sealed record BridgeObserveRequest();
internal sealed record BridgeCancelRequest(string RequestId, string ExecutionId, string ReasonCode);
