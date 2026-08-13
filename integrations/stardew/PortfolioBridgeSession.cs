using System.Text.Json;

namespace GameBuddy.Stardew;

/// <summary>Game-thread-owned authenticated Portfolio session.</summary>
internal sealed class PortfolioBridgeSession
{
    private readonly PortfolioLocalPlayerBinding binding;
    private readonly PortfolioConfig config;
    private readonly string token;
    private long authenticatedGeneration = -1;

    internal PortfolioBridgeSession(PortfolioLocalPlayerBinding binding, PortfolioConfig config, string token)
    {
        this.binding = binding;
        this.config = config;
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

    internal bool TrySleepDay(
        long connectionGeneration,
        string json,
        PortfolioSleepDayCoordinator coordinator,
        long currentRevision,
        out PortfolioEnvelope<PortfolioSleepDayReceipt>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeSleepDayRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioSleepDayRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "sleep_day_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SleepDayAction))
        {
            // The public portfolio wire reason is not yet present in the closed
            // C# protocol registry. Keep this rejection closed until that
            // cross-layer contract is explicitly added; importantly, do not
            // call the coordinator, so idempotency is not consumed.
            reasonCode = "invalid_request";
            return false;
        }

        response = Reply("sleep_day_receipt", request.CorrelationId, coordinator.Begin(request.Payload, currentRevision, this.binding.ToScope()));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryMineElevator(
        long connectionGeneration,
        string json,
        PortfolioMineElevatorActionCoordinator coordinator,
        PortfolioMineElevatorSemanticAdapter adapter,
        long currentRevision,
        out PortfolioEnvelope<PortfolioMineElevatorActionReceipt>? response,
        out PortfolioMineElevatorActionPhase? phase,
        out string reasonCode)
    {
        response = null;
        phase = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineElevatorRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineElevatorActionRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "mine_elevator_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction))
        {
            reasonCode = "invalid_request";
            return false;
        }

        PortfolioMineElevatorFreshObservation observation = adapter.CreateFreshObservation(request.Payload, this.binding.ToScope(), currentRevision);
        PortfolioMineElevatorActionBeginResult result = coordinator.Begin(request.Payload, observation, request.CorrelationId);
        if (result.IsAccepted)
            phase = result.Phase;
        else if (result.Receipt is not null)
            response = Reply("mine_elevator_receipt", request.CorrelationId, result.Receipt);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryProbeMineElevator(
        long connectionGeneration,
        string json,
        PortfolioMineElevatorSemanticAdapter adapter,
        long currentRevision,
        out PortfolioEnvelope<PortfolioMineElevatorProbe>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineElevatorProbeRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineElevatorActionRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "mine_elevator_probe_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction))
        {
            reasonCode = "invalid_request";
            return false;
        }
        if (request.Payload.ExpectedRevision != currentRevision)
        {
            reasonCode = "revision_mismatch";
            return false;
        }
        PortfolioMineElevatorFreshObservation observation = adapter.CreateFreshObservation(request.Payload, this.binding.ToScope(), currentRevision);
        response = Reply("mine_elevator_probe", request.CorrelationId, new PortfolioMineElevatorProbe(
            observation.RequestId, observation.TraceId, observation.Scope, observation.Revision,
            observation.Fresh, observation.MineEntryObserved, observation.CurrentFloor,
            observation.LowestMineLevel, observation.TargetUnlocked, request.Payload.SelectedCheckpoint));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryReadMineElevatorFreshFloor(
        long connectionGeneration,
        string json,
        PortfolioMineElevatorActionCoordinator coordinator,
        PortfolioMineElevatorSemanticAdapter adapter,
        long currentRevision,
        out PortfolioEnvelope<PortfolioMineElevatorFreshFloor>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineElevatorFreshFloorRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineElevatorFreshFloorRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "mine_elevator_fresh_floor_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction)
            || !coordinator.TryValidateFreshFloorRequest(request.Payload, currentRevision, out int selectedCheckpoint))
        {
            reasonCode = "invalid_portfolio_mine_elevator_fresh_floor_request";
            return false;
        }
        if (!adapter.TryReadTerminalFreshFloor(request.Payload, this.binding.ToScope(), selectedCheckpoint, currentRevision, out PortfolioMineElevatorFreshFloor? floor)
            || floor is null)
        {
            reasonCode = "invalid_portfolio_mine_elevator_fresh_floor";
            return false;
        }
        response = Reply("mine_elevator_fresh_floor", request.CorrelationId, floor);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryCancelMineElevator(
        long connectionGeneration,
        string json,
        PortfolioMineElevatorActionCoordinator coordinator,
        out PortfolioEnvelope<PortfolioMineElevatorActionReceipt>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineElevatorCancelRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineElevatorActionCancelRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "mine_elevator_cancel_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction))
        {
            reasonCode = "invalid_request";
            return false;
        }

        response = Reply("mine_elevator_receipt", request.CorrelationId, coordinator.Cancel(request.Payload));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryCancelSleepDay(
        long connectionGeneration,
        string json,
        PortfolioSleepDayCoordinator coordinator,
        out PortfolioEnvelope<PortfolioSleepDayReceipt>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeSleepDayCancelRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioSleepDayCancelRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "sleep_day_cancel_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SleepDayAction))
        {
            reasonCode = "invalid_request";
            return false;
        }

        response = Reply("sleep_day_receipt", request.CorrelationId, coordinator.Cancel(request.Payload));
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
