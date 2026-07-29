using System.Security.Cryptography;

namespace GameBuddy.Stardew;

/// <summary>
/// Transport-neutral, game-thread-only Phase 2 session. A future local IPC
/// adapter may enqueue already bounded/parsed envelopes to this class; it must
/// never execute Stardew APIs on its background I/O thread. No listener is
/// created by this class.
/// </summary>
internal sealed class BridgeSession
{
    private readonly ExecutionManager executions;
    private readonly BridgeScope scope;
    private readonly string token;
    private bool authenticated;

    internal BridgeSession(ExecutionManager executions, BridgeScope scope, string token)
    {
        this.executions = executions;
        this.scope = scope;
        this.token = token;
    }

    internal bool TryAuthenticate(BridgeEnvelope<BridgeHello> envelope, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string reasonCode)
    {
        acknowledgement = null;
        if (!IsValidEnvelope(envelope, "hello", out reasonCode) || !CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(envelope.Payload.Token),
            System.Text.Encoding.UTF8.GetBytes(this.token)))
        {
            reasonCode = "authentication_failed";
            return false;
        }

        this.authenticated = true;
        acknowledgement = Reply("hello_ack", envelope.CorrelationId, new BridgeHelloAck(Guid.NewGuid().ToString("N"), new[] { "move_to_tile", "inspect_self" }));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryObserve(BridgeEnvelope<BridgeObserveRequest> envelope, out BridgeEnvelope<BridgeSnapshot>? response, out string reasonCode)
    {
        response = null;
        if (!this.authenticated)
        {
            reasonCode = "unauthenticated";
            return false;
        }
        if (!IsValidEnvelope(envelope, "observe_request", out reasonCode))
            return false;

        response = Reply("snapshot", envelope.CorrelationId, this.executions.CreateBridgeSnapshot());
        reasonCode = "accepted";
        return true;
    }

    internal bool TryExecute(BridgeEnvelope<BridgeExecutionRequest> envelope, out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode)
    {
        response = null;
        if (!this.authenticated)
        {
            reasonCode = "unauthenticated";
            return false;
        }
        if (!IsValidEnvelope(envelope, "execution_request", out reasonCode))
            return false;

        BridgeExecutionRequest request = envelope.Payload;
        if (!BridgeProtocol.IsOpaqueId(request.RequestId) || !BridgeProtocol.IsOpaqueId(request.IdempotencyKey)
            || request.Action != "move_to_tile" || !float.IsFinite(request.TargetX) || !float.IsFinite(request.TargetY)
            || request.TargetX < 0 || request.TargetY < 0 || request.TargetX > 1000 || request.TargetY > 1000
            || request.ExpectedRevision != this.executions.Revision || request.DeadlineMs < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            || request.DeadlineMs > DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds())
        {
            reasonCode = "invalid_execution_request";
            return false;
        }

        LocalExecutionReceipt receipt = this.executions.RequestLocalMove(request.RequestId, new Microsoft.Xna.Framework.Vector2(request.TargetX, request.TargetY));
        response = Reply("execution_receipt", envelope.CorrelationId, ToBridgeReceipt(receipt));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryCancel(BridgeEnvelope<BridgeCancelRequest> envelope, out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode)
    {
        response = null;
        if (!this.authenticated)
        {
            reasonCode = "unauthenticated";
            return false;
        }
        if (!IsValidEnvelope(envelope, "cancel_request", out reasonCode))
            return false;

        if (!BridgeProtocol.IsOpaqueId(envelope.Payload.RequestId) || !BridgeProtocol.IsOpaqueId(envelope.Payload.ExecutionId) || !BridgeProtocol.IsReasonCode(envelope.Payload.ReasonCode))
        {
            reasonCode = "invalid_cancel_request";
            return false;
        }

        LocalExecutionReceipt receipt = this.executions.Cancel(envelope.Payload.ReasonCode);
        response = Reply("execution_receipt", envelope.CorrelationId, ToBridgeReceipt(receipt));
        reasonCode = "accepted";
        return true;
    }

    private bool IsValidEnvelope<TPayload>(BridgeEnvelope<TPayload> envelope, string expectedType, out string reasonCode)
    {
        if (envelope.ProtocolVersion != BridgeProtocol.Version || envelope.Type != expectedType || !BridgeProtocol.IsOpaqueId(envelope.MessageId) || !BridgeProtocol.IsOpaqueId(envelope.CorrelationId) || !envelope.Scope.Equals(this.scope))
        {
            reasonCode = "invalid_envelope";
            return false;
        }

        if (Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - envelope.TimestampMs) > TimeSpan.FromMinutes(5).TotalMilliseconds)
        {
            reasonCode = "stale_or_invalid_timestamp";
            return false;
        }

        reasonCode = "accepted";
        return true;
    }

    private BridgeEnvelope<TPayload> Reply<TPayload>(string type, string correlationId, TPayload payload) => new(
        BridgeProtocol.Version, Guid.NewGuid().ToString("N"), correlationId,
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), this.scope, type, payload);

    private static BridgeReceipt ToBridgeReceipt(LocalExecutionReceipt receipt) => new(
        receipt.ExecutionId, receipt.RequestId, receipt.State.ToWireValue(), receipt.ReasonCode, receipt.Revision,
        receipt.Evidence is null ? null : new Dictionary<string, string> { ["detail"] = receipt.Evidence });
}

internal sealed record BridgeHello(string Token);
internal sealed record BridgeHelloAck(string SessionId, IReadOnlyList<string> Capabilities);
internal sealed record BridgeObserveRequest();
internal sealed record BridgeExecutionRequest(string RequestId, string IdempotencyKey, string Action, float TargetX, float TargetY, long ExpectedRevision, long DeadlineMs);
internal sealed record BridgeCancelRequest(string RequestId, string ExecutionId, string ReasonCode);
