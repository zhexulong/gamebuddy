using System.Text.Json;

namespace GameBuddy.Stardew;

/// <summary>Game-thread-owned authenticated Portfolio session.</summary>
internal sealed class PortfolioBridgeSession
{
    private readonly PortfolioLocalPlayerBinding binding;
    private readonly PortfolioConfig config;
    private readonly string token;
    private long authenticatedGeneration = -1;
    private readonly PortfolioBootstrapHandoff bootstrapHandoff = new();

    internal PortfolioBridgeSession(PortfolioLocalPlayerBinding binding, PortfolioConfig config, string token)
    {
        this.binding = binding;
        this.config = config;
        this.token = token;
    }

    internal bool TryBootstrapHello(long connectionGeneration, string json, out PortfolioEnvelope<PortfolioHelloAck>? response, out string reasonCode)
    {
        response = null;
        // Bootstrap is a one-shot identity probe. Once observed, this session
        // may only perform the explicitly armed immediate successor handoff;
        // it must never become a general reconnect path.
        if (this.bootstrapHandoff.IsStrictGenerationConsumed || this.authenticatedGeneration >= 0
            || this.bootstrapHandoff.HasBootstrapGeneration)
        {
            reasonCode = "portfolio_bootstrap_not_allowed";
            return false;
        }
        if (!PortfolioBridgeProtocol.TryDeserializeBootstrapHello(json, this.binding, this.token,
                out PortfolioEnvelope<PortfolioBootstrapHello>? request, out reasonCode) || request is null)
            return false;
        if (!this.bootstrapHandoff.TryRecordBootstrap(connectionGeneration))
        {
            reasonCode = "portfolio_bootstrap_not_allowed";
            return false;
        }
        response = new PortfolioEnvelope<PortfolioHelloAck>(
            PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), request.CorrelationId,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), this.binding.ToScope(), "bootstrap_hello_ack",
            new PortfolioHelloAck(Guid.NewGuid().ToString("N"), this.binding.BindingGeneration, this.binding.BindingHash));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryAuthenticate(long connectionGeneration, PortfolioEnvelope<PortfolioHello>? envelope, out PortfolioEnvelope<PortfolioHelloAck>? response, out string reasonCode)
    {
        response = null;
        if (this.bootstrapHandoff.IsBootstrapGeneration(connectionGeneration)
            || this.bootstrapHandoff.IsStrictGenerationConsumed
            || (this.bootstrapHandoff.IsExpectedStrictGeneration(connectionGeneration) == false
                && this.bootstrapHandoff.HasExpectedStrictGeneration
                && this.bootstrapHandoff.ExpectedStrictGeneration != connectionGeneration))
        {
            reasonCode = "portfolio_bootstrap_not_allowed";
            return false;
        }
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

        if (this.bootstrapHandoff.HasExpectedStrictGeneration
            && !this.bootstrapHandoff.TryAcceptStrictHello(connectionGeneration))
        {
            reasonCode = "portfolio_bootstrap_not_allowed";
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
            observation.LowestMineLevel, observation.TargetUnlocked, observation.ElevatorObserved, request.Payload.SelectedCheckpoint));
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

    internal bool TryMineLadder(
        long connectionGeneration,
        string json,
        PortfolioMineLadderActionCoordinator coordinator,
        PortfolioMineLadderSemanticAdapter adapter,
        long currentRevision,
        out PortfolioEnvelope<PortfolioMineLadderActionReceipt>? response,
        out PortfolioMineLadderActionPhase? phase,
        out string reasonCode)
    {
        response = null;
        phase = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineLadderRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineLadderActionRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "mine_ladder_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction))
        {
            reasonCode = "invalid_request";
            return false;
        }

        PortfolioMineLadderFreshObservation observation = adapter.CreateFreshObservation(request.Payload, this.binding.ToScope(), currentRevision);
        PortfolioMineLadderActionBeginResult result = coordinator.Begin(request.Payload, observation, request.CorrelationId);
        if (result.IsAccepted)
            phase = result.Phase;
        else if (result.Receipt is not null)
            response = Reply("mine_ladder_receipt", request.CorrelationId, result.Receipt);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryProbeMineLadder(
        long connectionGeneration,
        string json,
        PortfolioMineLadderSemanticAdapter adapter,
        long currentRevision,
        out PortfolioEnvelope<PortfolioMineLadderProbe>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineLadderProbeRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineLadderActionRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "mine_ladder_probe_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction))
        {
            reasonCode = "invalid_request";
            return false;
        }
        if (request.Payload.ExpectedRevision != currentRevision)
        {
            reasonCode = "revision_mismatch";
            return false;
        }
        PortfolioMineLadderFreshObservation observation = adapter.CreateFreshObservation(request.Payload, this.binding.ToScope(), currentRevision);
        response = Reply("mine_ladder_probe", request.CorrelationId, new PortfolioMineLadderProbe(
            observation.RequestId, observation.TraceId, observation.Scope, observation.Revision,
            observation.Fresh, observation.MineEntryObserved, observation.CurrentFloor,
            observation.LowestMineLevel, observation.TargetUnlocked, observation.LadderObserved, observation.TargetFloor));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryReadMineLadderFreshFloor(
        long connectionGeneration,
        string json,
        PortfolioMineLadderActionCoordinator coordinator,
        PortfolioMineLadderSemanticAdapter adapter,
        long currentRevision,
        out PortfolioEnvelope<PortfolioMineLadderFreshFloor>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineLadderFreshFloorRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineLadderFreshFloorRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "mine_ladder_fresh_floor_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction)
            || !coordinator.TryValidateFreshFloorRequest(request.Payload, currentRevision, out int targetFloor))
        {
            reasonCode = "invalid_portfolio_mine_ladder_fresh_floor_request";
            return false;
        }
        if (!adapter.TryReadTerminalFreshFloor(request.Payload, this.binding.ToScope(), targetFloor, currentRevision, out PortfolioMineLadderFreshFloor? floor)
            || floor is null)
        {
            reasonCode = "invalid_portfolio_mine_ladder_fresh_floor";
            return false;
        }
        response = Reply("mine_ladder_fresh_floor", request.CorrelationId, floor);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryCancelMineLadder(
        long connectionGeneration,
        string json,
        PortfolioMineLadderActionCoordinator coordinator,
        out PortfolioEnvelope<PortfolioMineLadderActionReceipt>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineLadderCancelRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineLadderActionCancelRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "mine_ladder_cancel_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction))
        {
            reasonCode = "invalid_request";
            return false;
        }

        response = Reply("mine_ladder_receipt", request.CorrelationId, coordinator.Cancel(request.Payload));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryMineEntry(
        long connectionGeneration,
        string json,
        PortfolioMineEntryActionCoordinator coordinator,
        PortfolioMineEntrySemanticAdapter adapter,
        long currentRevision,
        out PortfolioEnvelope<PortfolioMineEntryActionReceipt>? response,
        out PortfolioMineEntryActionPhase? phase,
        out string reasonCode)
    {
        response = null;
        phase = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineEntryRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineEntryActionRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "enter_mine_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction))
        {
            reasonCode = "invalid_request";
            return false;
        }

        PortfolioMineEntryFreshObservation observation = adapter.CreateFreshObservation(request.Payload, this.binding.ToScope(), currentRevision);
        PortfolioMineEntryActionBeginResult result = coordinator.Begin(request.Payload, observation, request.CorrelationId);
        if (result.IsAccepted)
            phase = result.Phase;
        else if (result.Receipt is not null)
            response = Reply("enter_mine_receipt", request.CorrelationId, result.Receipt);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryProbeMineEntry(
        long connectionGeneration,
        string json,
        PortfolioMineEntrySemanticAdapter adapter,
        long currentRevision,
        out PortfolioEnvelope<PortfolioMineEntryProbe>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineEntryProbeRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineEntryActionRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "enter_mine_probe_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction))
        {
            reasonCode = "invalid_request";
            return false;
        }
        if (request.Payload.ExpectedRevision != currentRevision)
        {
            reasonCode = "revision_mismatch";
            return false;
        }
        PortfolioMineEntryFreshObservation observation = adapter.CreateFreshObservation(request.Payload, this.binding.ToScope(), currentRevision);
        response = Reply("enter_mine_probe", request.CorrelationId, new PortfolioMineEntryProbe(
            observation.RequestId, observation.TraceId, observation.Scope, observation.Revision,
            observation.Fresh, observation.MineEntryObserved, observation.CurrentFloor,
            observation.LowestMineLevel, observation.TargetUnlocked, observation.TargetFloor));
        reasonCode = "accepted";
        return true;
    }

    internal bool TryReadMineEntryFreshFloor(
        long connectionGeneration,
        string json,
        PortfolioMineEntryActionCoordinator coordinator,
        PortfolioMineEntrySemanticAdapter adapter,
        long currentRevision,
        out PortfolioEnvelope<PortfolioMineEntryFreshFloor>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineEntryFreshFloorRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineEntryFreshFloorRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "enter_mine_fresh_floor_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction)
            || !coordinator.TryValidateFreshFloorRequest(request.Payload, currentRevision, out int targetFloor))
        {
            reasonCode = "invalid_portfolio_enter_mine_fresh_floor_request";
            return false;
        }
        if (!adapter.TryReadTerminalFreshFloor(request.Payload, this.binding.ToScope(), targetFloor, currentRevision, out PortfolioMineEntryFreshFloor? floor)
            || floor is null)
        {
            reasonCode = "invalid_portfolio_enter_mine_fresh_floor";
            return false;
        }
        response = Reply("enter_mine_fresh_floor", request.CorrelationId, floor);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryCancelMineEntry(
        long connectionGeneration,
        string json,
        PortfolioMineEntryActionCoordinator coordinator,
        out PortfolioEnvelope<PortfolioMineEntryActionReceipt>? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeMineEntryCancelRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioMineEntryActionCancelRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "enter_mine_cancel_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction))
        {
            reasonCode = "invalid_request";
            return false;
        }

        response = Reply("enter_mine_receipt", request.CorrelationId, coordinator.Cancel(request.Payload));
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

    internal bool TrySkipEvent(
        long connectionGeneration,
        string json,
        PortfolioSkipEventActionCoordinator coordinator,
        IPortfolioSkipEventObservationAdapter adapter,
        long currentRevision,
        out string? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeSkipEventRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioSkipEventActionRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "skip_event_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SkipEventAction))
        {
            reasonCode = "invalid_request";
            return false;
        }

        PortfolioSkipEventFreshObservation observation = adapter.CreateFreshObservation(request.Payload, this.binding.ToScope(), currentRevision);
        PortfolioSkipEventActionBeginResult result = coordinator.Begin(request.Payload, observation, request.CorrelationId);
        if (result.IsAccepted)
        {
            response = SerializeReply("skip_event_phase", request.CorrelationId, result.Phase!);
        }
        else if (result.Receipt is not null)
        {
            response = SerializeReply("skip_event_receipt", request.CorrelationId, result.Receipt);
        }
        reasonCode = "accepted";
        return true;
    }

    internal bool TrySkipEventProbe(
        long connectionGeneration,
        string json,
        PortfolioSkipEventActionCoordinator coordinator,
        IPortfolioSkipEventObservationAdapter adapter,
        long currentRevision,
        out string? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeSkipEventProbeRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioSkipEventActionRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "skip_event_probe_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SkipEventAction))
        {
            reasonCode = "invalid_request";
            return false;
        }
        if (request.Payload.ExpectedRevision != currentRevision)
        {
            reasonCode = "revision_mismatch";
            return false;
        }
        PortfolioSkipEventFreshObservation observation = adapter.CreateFreshObservation(request.Payload, this.binding.ToScope(), currentRevision);
        PortfolioSkipEventProbe probe = new(
            observation.RequestId, observation.TraceId, observation.Scope, observation.Revision,
            observation.Fresh, observation.EventObserved, observation.EventSkippable, observation.OpaqueEventTarget);
        response = SerializeReply("skip_event_probe", request.CorrelationId, probe);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryCancelSkipEvent(
        long connectionGeneration,
        string json,
        PortfolioSkipEventActionCoordinator coordinator,
        IPortfolioSkipEventObservationAdapter adapter,
        out string? response,
        out string reasonCode)
    {
        response = null;
        if (!PortfolioBridgeProtocol.TryDeserializeSkipEventCancelRequest(json, this.binding.ToScope(), out PortfolioEnvelope<PortfolioSkipEventActionCancelRequest>? request, out reasonCode)
            || request is null
            || !IsAuthenticatedEnvelope(connectionGeneration, request, "skip_event_cancel_request", out reasonCode))
            return false;
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SkipEventAction))
        {
            reasonCode = "invalid_request";
            return false;
        }

        response = SerializeReply("skip_event_receipt", request.CorrelationId, coordinator.Cancel(request.Payload));
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

    internal bool IsBootstrapGeneration(long connectionGeneration) => this.bootstrapHandoff.IsBootstrapGeneration(connectionGeneration);

    internal bool HasBootstrapHandoff => this.bootstrapHandoff.HasBootstrapGeneration;

    // A fresh pipe's first generation must be allowed to deliver the one
    // bootstrap_hello that records it. All later unauthenticated generations
    // require the explicit bootstrap successor state.
    internal bool CanAcceptInitialGeneration(long connectionGeneration) => connectionGeneration > 0
        && this.authenticatedGeneration < 0 && !this.bootstrapHandoff.HasBootstrapGeneration
        && !this.bootstrapHandoff.HasExpectedStrictGeneration && !this.bootstrapHandoff.IsStrictGenerationConsumed;

    internal bool IsBootstrapHandoffAwaitingDisconnect => this.bootstrapHandoff.HasBootstrapGeneration
        && !this.bootstrapHandoff.HasExpectedStrictGeneration
        && !this.bootstrapHandoff.IsStrictGenerationConsumed;

    internal bool IsBootstrapSuccessorGeneration(long connectionGeneration) => this.bootstrapHandoff.IsBootstrapSuccessorGeneration(connectionGeneration);

    internal bool IsExpectedStrictGeneration(long connectionGeneration) => this.bootstrapHandoff.IsExpectedStrictGeneration(connectionGeneration);

    /// <summary>
    /// Transfers one bootstrap disconnect from the background pipe worker to
    /// the game-thread session. Only a bootstrap generation with no active
    /// execution may arm exactly generation + 1 for strict hello.
    /// </summary>
    internal bool TryConsumeBootstrapDisconnect(long disconnectedGeneration, bool activeExecution, out string reasonCode)
    {
        if (this.authenticatedGeneration >= 0 || !this.bootstrapHandoff.IsBootstrapGeneration(disconnectedGeneration))
        {
            reasonCode = "portfolio_bootstrap_not_allowed";
            return false;
        }
        return this.bootstrapHandoff.TryConsumeDisconnect(disconnectedGeneration, activeExecution, out reasonCode);
    }

    private bool IsEnvelopeValid<TPayload>(long connectionGeneration, PortfolioEnvelope<TPayload>? envelope, string expectedType, bool requireAuthentication, out string reasonCode)
    {
        if (requireAuthentication && (this.authenticatedGeneration != connectionGeneration
            || this.bootstrapHandoff.IsBootstrapGeneration(connectionGeneration)
            || this.bootstrapHandoff.IsExpectedStrictGeneration(connectionGeneration)))
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

    /// <summary>Serializes a bound reply envelope for outward delivery.</summary>
    private string? SerializeReply<TPayload>(string type, string correlationId, TPayload payload)
    {
        PortfolioEnvelope<TPayload> response = Reply(type, correlationId, payload);
        return PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : null;
    }
}
