using System.Text.Json;

namespace GameBuddy.Stardew;

/// <summary>Game-thread-owned authenticated observe-only Portfolio session.</summary>
internal sealed class PortfolioBridgeSession
{
    private readonly PortfolioLocalPlayerBinding binding;
    private readonly string token;
    private long authenticatedGeneration = -1;

    internal PortfolioBridgeSession(PortfolioLocalPlayerBinding binding, string token)
    {
        this.binding = binding;
        this.token = token;
    }

    internal bool TryAuthenticate(long connectionGeneration, PortfolioEnvelope<PortfolioHello>? envelope, out PortfolioEnvelope<PortfolioHelloAck>? response, out string reasonCode)
    {
        response = null;
        if (!IsEnvelopeValid(connectionGeneration, envelope, "hello", requireAuthentication: false, out reasonCode)
            || envelope!.Payload is null
            || envelope.Payload.ExtensionData is { Count: > 0 }
            || !PortfolioBridgeProtocol.IsToken(envelope.Payload.Token)
            || !PortfolioBridgeProtocol.FixedEquals(envelope.Payload.Token, this.token))
        {
            reasonCode = "authentication_failed";
            return false;
        }
        if (this.authenticatedGeneration == connectionGeneration)
        {
            reasonCode = "already_authenticated";
            return false;
        }

        this.authenticatedGeneration = connectionGeneration;
        response = Reply("hello_ack", envelope.CorrelationId, new PortfolioHelloAck(Guid.NewGuid().ToString("N"), this.binding.BindingGeneration, this.binding.BindingHash));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryObserve(long connectionGeneration, PortfolioEnvelope<PortfolioObserveRequest>? envelope, PortfolioSnapshot snapshot, out PortfolioEnvelope<PortfolioSnapshot>? response, out string reasonCode)
    {
        response = null;
        if (!IsAuthenticatedEnvelope(connectionGeneration, envelope, "observe_request", out reasonCode)
            || envelope!.Payload is null
            || envelope.Payload.ExtensionData is { Count: > 0 })
            return false;

        response = Reply("snapshot", envelope.CorrelationId, snapshot);
        reasonCode = "accepted";
        return true;
    }

    internal bool IsAuthenticatedEnvelope<TPayload>(long connectionGeneration, PortfolioEnvelope<TPayload>? envelope, string expectedType, out string reasonCode)
        => IsEnvelopeValid(connectionGeneration, envelope, expectedType, requireAuthentication: true, out reasonCode);

    internal PortfolioEnvelope<PortfolioError> CreateError(string? correlationId, string reasonCode) => Reply(
        "error",
        PortfolioBridgeProtocol.IsOpaqueId(correlationId) ? correlationId! : Guid.NewGuid().ToString("N"),
        new PortfolioError(PortfolioBridgeProtocol.IsReasonCode(reasonCode) ? reasonCode : "invalid_request"));

    /// <summary>Creates one unsolicited final snapshot for native invalidation.</summary>
    internal PortfolioEnvelope<PortfolioSnapshot> CreateInvalidation(PortfolioSnapshot snapshot) => Reply(
        "snapshot",
        Guid.NewGuid().ToString("N"),
        snapshot);

    internal bool IsAuthenticatedGeneration(long connectionGeneration) => this.authenticatedGeneration == connectionGeneration;

    private bool IsEnvelopeValid<TPayload>(long connectionGeneration, PortfolioEnvelope<TPayload>? envelope, string expectedType, bool requireAuthentication, out string reasonCode)
    {
        if (requireAuthentication && this.authenticatedGeneration != connectionGeneration)
        {
            reasonCode = "unauthenticated";
            return false;
        }
        if (envelope is null || envelope.ExtensionData is { Count: > 0 } || envelope.ProtocolVersion != PortfolioBridgeProtocol.Version
            || envelope.Type != expectedType || !PortfolioBridgeProtocol.IsOpaqueId(envelope.MessageId)
            || !PortfolioBridgeProtocol.IsOpaqueId(envelope.CorrelationId) || envelope.Scope is null
            || !envelope.Scope.IsValid || !envelope.Scope.Equals(this.binding.ToScope()))
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

    private PortfolioEnvelope<TPayload> Reply<TPayload>(string type, string correlationId, TPayload payload) => new(
        PortfolioBridgeProtocol.Version,
        Guid.NewGuid().ToString("N"),
        correlationId,
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        this.binding.ToScope(),
        type,
        payload);
}
