using System.Text.Json;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private PortfolioSleepDayCoordinator? portfolioSleepDayCoordinator;
    private PortfolioMineElevatorActionCoordinator? portfolioMineElevatorCoordinator;
    private PortfolioMineElevatorSemanticAdapter? portfolioMineElevatorAdapter;
    private void TryInitializePortfolioBinding()
    {
        PortfolioConfig? config = this.config.Portfolio;
        if (config is not { Enable: true })
            return;
        // An armed one-shot initial load is the only permitted bootstrap into
        // this M8 profile. A rejected completion stays terminal for this Mod
        // process; it must never fall through to the ordinary loaded-world
        // binding path on a later tick.
        if (config.InitialNativeLoad is { Enable: true } ||
            (this.portfolioInitialNativeLoadTerminal && !this.portfolioInitialNativeLoadSucceeded))
            return;
        if (!config.IsValid)
        {
            this.InvalidatePortfolioState("portfolio_configuration_invalid");
            return;
        }
        if (!Context.IsWorldReady || !Game1.hasLoadedGame || Game1.player is null || Context.IsMultiplayer || !Game1.IsMasterGame)
        {
            this.InvalidatePortfolioState(Context.IsWorldReady ? "portfolio_single_player_required" : "portfolio_world_not_ready");
            return;
        }
        if (Game1.uniqueIDForThisGame.ToString() != config.SaveId
            || Game1.MasterPlayer.UniqueMultiplayerID.ToString() != config.WorldId
            || Game1.player.UniqueMultiplayerID.ToString() != config.LocalPlayerId)
        {
            this.InvalidatePortfolioState("portfolio_scope_mismatch");
            return;
        }
        if (this.portfolioBinding is null)
        {
            this.portfolioBindingGeneration++;
            this.portfolioBinding = PortfolioLocalPlayerBinding.Create(
                config.SaveId,
                config.WorldId,
                config.LocalPlayerId,
                config.CompanionId,
                this.portfolioBindingGeneration,
                this.portfolioLastObservedRevision < 0 ? 0 : this.portfolioLastObservedRevision,
                Game1.ticks);
            this.portfolioLastObservedRevision = -1;
            this.portfolioBridgeSession = new PortfolioBridgeSession(this.portfolioBinding, config, config.BridgeToken);
            this.portfolioSleepDayCoordinator = new PortfolioSleepDayCoordinator();
            this.portfolioMineElevatorAdapter = new PortfolioMineElevatorSemanticAdapter(
                config,
                () => this.IsPortfolioBindingCurrent(out _),
                () => ++this.portfolioLastObservedRevision,
                observation => this.portfolioMineElevatorCoordinator?.ObserveTransitionStarted(observation) == true,
                observation => this.portfolioMineElevatorCoordinator?.ObservePostcondition(observation)
                    ?? throw new InvalidOperationException("portfolio_mine_elevator_not_armed"),
                (requestId, traceId, executionId, reasonCode, revision, scope) => this.portfolioMineElevatorCoordinator?.Fail(
                    requestId, traceId, executionId, reasonCode, revision, scope)
                    ?? throw new InvalidOperationException("portfolio_mine_elevator_not_armed"));
            this.portfolioMineElevatorCoordinator = new PortfolioMineElevatorActionCoordinator(this.portfolioMineElevatorAdapter);
            this.portfolioPipeBridge = config.EnableObserveBridge ? new PortfolioLocalPipeBridge(config.PipeName) : null;
            string sleepDayMutationState = config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SleepDayAction)
                ? "authorized"
                : "configured_but_not_authorized";
            this.Monitor.Log($"GameBuddy Portfolio binding opened for native local Player {config.LocalPlayerId}; observe_bridge={(config.EnableObserveBridge ? "enabled" : "disabled")}; sleep_day_mutation_route={sleepDayMutationState}; generation={this.portfolioBinding.BindingGeneration}.", LogLevel.Info);
        }
    }

    private void UpdatePortfolioBridge()
    {
        if (this.portfolioBinding is null || this.portfolioBridgeSession is null || this.portfolioPipeBridge is null)
            return;
        if (this.portfolioPipeBridge.TryConsumeDisconnect(out _))
        {
            this.ClearPortfolioState("portfolio_bridge_disconnected");
            return;
        }
        this.portfolioMineElevatorAdapter?.Watchdog(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        this.DrainPortfolioMineElevatorTerminalDeliveries();
        if (this.portfolioBinding.BindingGeneration != this.portfolioBindingGeneration)
        {
            this.InvalidatePortfolioState("portfolio_binding_generation_invalid");
            return;
        }
        if (!this.IsPortfolioBindingCurrent(out string reasonCode))
        {
            this.InvalidatePortfolioState(reasonCode);
            return;
        }
        long generation = this.portfolioPipeBridge.CurrentGeneration;
        if (generation == 0)
            return;
        for (int index = 0; index < 8 && this.portfolioPipeBridge.TryDequeueInbound(out PortfolioPipeInbound inbound); index++)
        {
            string? response = null;
            try
            {
                using JsonDocument document = JsonDocument.Parse(inbound.Json);
                if (document.RootElement.ValueKind != JsonValueKind.Object
                    || !document.RootElement.TryGetProperty("type", out JsonElement typeElement)
                    || typeElement.ValueKind != JsonValueKind.String)
                {
                    response = this.SerializePortfolioError(null, "invalid_envelope");
                }
                else
                {
                    string? correlationId = document.RootElement.TryGetProperty("correlationId", out JsonElement correlationElement)
                        && correlationElement.ValueKind == JsonValueKind.String ? correlationElement.GetString() : null;
                    response = typeElement.GetString() switch
                    {
                        "hello" => this.HandlePortfolioHello(inbound.Generation, inbound.Json),
                        "observe_request" => this.HandlePortfolioObserve(inbound.Generation, inbound.Json),
                        "sleep_day_request" => this.HandlePortfolioSleepDay(inbound.Generation, inbound.Json),
                        "sleep_day_cancel_request" => this.HandlePortfolioSleepDayCancel(inbound.Generation, inbound.Json),
                        "mine_elevator_probe_request" => this.HandlePortfolioMineElevatorProbe(inbound.Generation, inbound.Json),
                        "mine_elevator_fresh_floor_request" => this.HandlePortfolioMineElevatorFreshFloor(inbound.Generation, inbound.Json),
                        "mine_elevator_request" => this.HandlePortfolioMineElevator(inbound.Generation, inbound.Json),
                        "mine_elevator_cancel_request" => this.HandlePortfolioMineElevatorCancel(inbound.Generation, inbound.Json),
                        _ => this.SerializePortfolioError(correlationId, "portfolio_message_type_rejected"),
                    };
                }
            }
            catch (JsonException)
            {
                response = this.SerializePortfolioError(null, "invalid_json");
            }
            catch (Exception exception)
            {
                this.Monitor.Log($"GameBuddy rejected Portfolio bridge request: {exception.GetType().Name}.", LogLevel.Warn);
                response = this.SerializePortfolioError(null, "invalid_request");
            }
            if (response is not null)
            {
                bool bindingStillCurrent = this.IsPortfolioBindingCurrent(out string invalidationReason);
                bool queued = bindingStillCurrent
                    ? this.portfolioPipeBridge.TryEnqueueOutbound(inbound.Generation, response)
                    : this.portfolioPipeBridge.TryEnqueueFinal(inbound.Generation, response);
                if (!queued)
                {
                    this.Monitor.Log("GameBuddy discarded Portfolio bridge response after disconnect or backpressure.", LogLevel.Warn);
                    // An accepted M8 phase is the native-arm acknowledgement.
                    // Losing it after the coordinator may have crossed the
                    // adapter boundary must invalidate on this game thread;
                    // otherwise the armed execution can outlive its authority.
                    if (IsPortfolioMineElevatorAcceptedPhaseResponse(response))
                    {
                        this.InvalidatePortfolioState("portfolio_bridge_disconnected");
                        return;
                    }
                }
                if (!bindingStillCurrent)
                {
                    this.InvalidatePortfolioState(invalidationReason);
                    return;
                }
            }
        }
    }

    private string? HandlePortfolioHello(long generation, string json)
    {
        PortfolioEnvelope<PortfolioHello>? request = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioHello>>(json, PortfolioBridgeProtocol.JsonOptions);
        if (request is null || this.portfolioBridgeSession is null)
            return this.SerializePortfolioError(null, "invalid_envelope");
        if (!this.portfolioBridgeSession.TryAuthenticate(generation, request, out PortfolioEnvelope<PortfolioHelloAck>? response, out string reasonCode) || response is null)
            return this.SerializePortfolioError(request.CorrelationId, reasonCode);
        return PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _) ? serialized : this.SerializePortfolioError(request.CorrelationId, "response_serialization_failed");
    }

    private string? HandlePortfolioObserve(long generation, string json)
    {
        PortfolioEnvelope<PortfolioObserveRequest>? request = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioObserveRequest>>(json, PortfolioBridgeProtocol.JsonOptions);
        if (request is null || this.portfolioBridgeSession is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "invalid_envelope");
        PortfolioSnapshot snapshot = this.CreatePortfolioSnapshot();
        if (!this.portfolioBridgeSession.TryObserve(generation, request, snapshot, out PortfolioEnvelope<PortfolioSnapshot>? response, out string reasonCode) || response is null)
            return this.SerializePortfolioError(request.CorrelationId, reasonCode);
        return PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _) ? serialized : this.SerializePortfolioError(request.CorrelationId, "response_serialization_failed");
    }

    private string? HandlePortfolioSleepDay(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioSleepDayCoordinator is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_sleep_day_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SleepDayAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TrySleepDay(generation, json, this.portfolioSleepDayCoordinator, this.portfolioLastObservedRevision,
                out PortfolioEnvelope<PortfolioSleepDayReceipt>? response, out string reasonCode) || response is null)
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(response.CorrelationId, "response_serialization_failed");
    }

    private string? HandlePortfolioMineElevatorProbe(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineElevatorAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_mine_elevator_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryProbeMineElevator(generation, json, this.portfolioMineElevatorAdapter,
                this.portfolioLastObservedRevision,
                out PortfolioEnvelope<PortfolioMineElevatorProbe>? response, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return response is not null && PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private string? HandlePortfolioMineElevatorFreshFloor(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineElevatorCoordinator is null
            || this.portfolioMineElevatorAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_mine_elevator_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        long freshRevision = this.portfolioLastObservedRevision + 1;
        if (!this.portfolioBridgeSession.TryReadMineElevatorFreshFloor(generation, json, this.portfolioMineElevatorCoordinator,
                this.portfolioMineElevatorAdapter, freshRevision,
                out PortfolioEnvelope<PortfolioMineElevatorFreshFloor>? response, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        this.portfolioLastObservedRevision = freshRevision;
        return response is not null && PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private string? HandlePortfolioMineElevator(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineElevatorCoordinator is null
            || this.portfolioMineElevatorAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_mine_elevator_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryMineElevator(generation, json, this.portfolioMineElevatorCoordinator,
                this.portfolioMineElevatorAdapter, this.portfolioLastObservedRevision,
                out PortfolioEnvelope<PortfolioMineElevatorActionReceipt>? response,
                out PortfolioMineElevatorActionPhase? phase, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        if (phase is not null)
        {
            PortfolioEnvelope<PortfolioMineElevatorActionPhase> phaseEnvelope = new(
                PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), TryReadPortfolioCorrelationId(json) ?? Guid.NewGuid().ToString("N"),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), this.portfolioBinding.ToScope(), "mine_elevator_phase", phase);
            return PortfolioBridgeProtocol.TrySerialize(phaseEnvelope, out string phaseSerialized, out _)
                ? phaseSerialized
                : this.SerializePortfolioError(phaseEnvelope.CorrelationId, "response_serialization_failed");
        }
        return response is not null && PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private void DrainPortfolioMineElevatorTerminalDeliveries()
    {
        if (this.portfolioMineElevatorCoordinator is null || this.portfolioBridgeSession is null || this.portfolioPipeBridge is null)
            return;
        long generation = this.portfolioPipeBridge.CurrentGeneration;
        if (generation == 0 || !this.portfolioBridgeSession.IsAuthenticatedGeneration(generation))
            return;
        for (int index = 0; index < 8 && this.portfolioMineElevatorCoordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? delivery); index++)
        {
            bool completionFailed = false;
            if (delivery is not null && this.portfolioMineElevatorCoordinator.TryCompleteTerminalDelivery(delivery, generation, out completionFailed))
                continue;
            if (completionFailed)
            {
                this.InvalidatePortfolioState("portfolio_bridge_disconnected");
                return;
            }
            if (delivery is not null && this.portfolioMineElevatorCoordinator.IsTerminalDeliveryPending(delivery))
                break;
            if (delivery is null || !delivery.Receipt.IsStructurallyTerminal)
            {
                if (delivery is not null)
                    this.portfolioMineElevatorCoordinator.TryAcknowledgeTerminalDelivery(delivery);
                continue;
            }
            PortfolioEnvelope<PortfolioMineElevatorActionReceipt> envelope = new(
                PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), delivery.CorrelationId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), delivery.Scope, "mine_elevator_receipt", delivery.Receipt);
            if (!PortfolioBridgeProtocol.TrySerialize(envelope, out string serialized, out _))
            {
                this.InvalidatePortfolioState("response_serialization_failed");
                return;
            }
            // Peek first: a terminal receipt remains owned by the coordinator
            // until this exact connection generation accepts it. Never replay it
            // into a later generation after a disconnect or backpressure fault.
            if (!this.portfolioPipeBridge.TryEnqueueOutbound(generation, serialized, out PortfolioPipeOutboundCompletion completion)
                || !this.portfolioMineElevatorCoordinator.TryArmTerminalDelivery(delivery, completion))
            {
                this.InvalidatePortfolioState("portfolio_bridge_disconnected");
                return;
            }
            // Do not acknowledge on enqueue. The next game-thread update polls
            // the generation-bound completion after WriteFrameAsync + FlushAsync.
            break;
        }
    }

    private string? HandlePortfolioMineElevatorCancel(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineElevatorCoordinator is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_mine_elevator_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryCancelMineElevator(generation, json, this.portfolioMineElevatorCoordinator,
                out PortfolioEnvelope<PortfolioMineElevatorActionReceipt>? response, out string reasonCode) || response is null)
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(response.CorrelationId, "response_serialization_failed");
    }

    private string? HandlePortfolioSleepDayCancel(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioSleepDayCoordinator is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_sleep_day_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SleepDayAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryCancelSleepDay(generation, json, this.portfolioSleepDayCoordinator,
                out PortfolioEnvelope<PortfolioSleepDayReceipt>? response, out string reasonCode) || response is null)
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(response.CorrelationId, "response_serialization_failed");
    }

    private static bool IsPortfolioMineElevatorAcceptedPhaseResponse(string json)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            return document.RootElement.TryGetProperty("type", out JsonElement type)
                && type.ValueKind == JsonValueKind.String
                && type.GetString() == "mine_elevator_phase"
                && document.RootElement.TryGetProperty("payload", out JsonElement payload)
                && payload.ValueKind == JsonValueKind.Object
                && payload.TryGetProperty("phase", out JsonElement phase)
                && phase.ValueKind == JsonValueKind.String
                && phase.GetString() == "accepted";
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static string? TryReadPortfolioCorrelationId(string json)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            return document.RootElement.TryGetProperty("correlationId", out JsonElement value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private PortfolioSnapshot CreatePortfolioSnapshot()
    {
        PortfolioLocalPlayerBinding binding = this.portfolioBinding!;
        bool current = this.IsPortfolioBindingCurrent(out string reasonCode);
        long revision = ++this.portfolioLastObservedRevision;
        return new PortfolioSnapshot(
            PortfolioBridgeProtocol.Version,
            PortfolioBridgeProtocol.IntegrationId,
            PortfolioBridgeProtocol.Topology,
            binding.SaveId,
            binding.WorldId,
            binding.LocalPlayerId,
            binding.CompanionId,
            binding.BindingGeneration,
            binding.BindingHash,
            revision,
            Context.IsWorldReady && Game1.hasLoadedGame,
            !Context.IsMultiplayer && Game1.IsMasterGame,
            current,
            current ? "ready" : "invalidated",
            current ? "accepted" : reasonCode);
    }

    private string SerializePortfolioError(string? correlationId, string reasonCode)
    {
        if (this.portfolioBridgeSession is null)
            return string.Empty;
        return PortfolioBridgeProtocol.TrySerialize(this.portfolioBridgeSession.CreateError(correlationId, reasonCode), out string json, out _)
            ? json
            : string.Empty;
    }

    private bool IsPortfolioBindingCurrent(out string reasonCode)
    {
        reasonCode = "accepted";
        PortfolioConfig? config = this.config.Portfolio;
        PortfolioLocalPlayerBinding? binding = this.portfolioBinding;
        if (config is not { Enable: true } || !config.IsValid || binding is null)
        {
            reasonCode = "portfolio_configuration_invalid";
            return false;
        }
        if (!Context.IsWorldReady || !Game1.hasLoadedGame || Game1.player is null)
        {
            reasonCode = "portfolio_world_not_ready";
            return false;
        }
        if (Context.IsMultiplayer || !Game1.IsMasterGame)
        {
            reasonCode = "portfolio_single_player_required";
            return false;
        }
        if (Game1.uniqueIDForThisGame.ToString() != binding.SaveId
            || Game1.MasterPlayer.UniqueMultiplayerID.ToString() != binding.WorldId
            || Game1.player.UniqueMultiplayerID.ToString() != binding.LocalPlayerId)
        {
            reasonCode = "portfolio_scope_mismatch";
            return false;
        }
        if (binding.BindingGeneration != this.portfolioBindingGeneration || !binding.IsValid)
        {
            reasonCode = "portfolio_binding_invalid";
            return false;
        }
        return true;
    }

    private void InvalidatePortfolioState(string reasonCode)
    {
        if (this.portfolioBinding is null && this.portfolioPipeBridge is null)
            return;

        PortfolioLocalPipeBridge? pipe = this.portfolioPipeBridge;
        bool finalQueued = false;
        if (pipe is not null && this.portfolioBridgeSession is not null && this.portfolioBinding is not null)
        {
            long generation = pipe.CurrentGeneration;
            if (generation > 0 && this.portfolioBridgeSession.IsAuthenticatedGeneration(generation)
                && PortfolioBridgeProtocol.TrySerialize(
                    this.portfolioBridgeSession.CreateInvalidation(this.CreatePortfolioInvalidationSnapshot(reasonCode)),
                    out string serialized,
                    out _))
            {
                finalQueued = pipe.TryEnqueueFinal(generation, serialized);
            }
        }

        if (!finalQueued)
            pipe?.Dispose();
        this.portfolioPipeBridge = null;
        this.portfolioBridgeSession = null;
        this.portfolioBinding = null;
        this.portfolioBindingGeneration++;
        this.portfolioLastObservedRevision = -1;
        this.portfolioSleepDayCoordinator = null;
        this.portfolioMineElevatorCoordinator?.Invalidate(reasonCode);
        this.portfolioMineElevatorCoordinator = null;
        this.portfolioMineElevatorAdapter?.DiscardPendingForInvalidation();
        this.portfolioMineElevatorAdapter = null;
        this.Monitor.Log($"GameBuddy invalidated Portfolio observe binding: {reasonCode}; final_snapshot={finalQueued}.", LogLevel.Warn);
    }

    private PortfolioSnapshot CreatePortfolioInvalidationSnapshot(string reasonCode)
    {
        PortfolioLocalPlayerBinding binding = this.portfolioBinding!;
        return new PortfolioSnapshot(
            PortfolioBridgeProtocol.Version,
            PortfolioBridgeProtocol.IntegrationId,
            PortfolioBridgeProtocol.Topology,
            binding.SaveId,
            binding.WorldId,
            binding.LocalPlayerId,
            binding.CompanionId,
            binding.BindingGeneration,
            binding.BindingHash,
            ++this.portfolioLastObservedRevision,
            false,
            !Context.IsMultiplayer && Game1.IsMasterGame,
            false,
            "invalidated",
            PortfolioBridgeProtocol.IsReasonCode(reasonCode) ? reasonCode : "portfolio_binding_invalid");
    }

    private void ClearPortfolioState(string reasonCode)
    {
        if (this.portfolioBinding is null && this.portfolioPipeBridge is null)
            return;
        this.portfolioPipeBridge?.Dispose();
        this.portfolioPipeBridge = null;
        this.portfolioBridgeSession = null;
        this.portfolioBinding = null;
        this.portfolioBindingGeneration++;
        this.portfolioLastObservedRevision = -1;
        this.portfolioSleepDayCoordinator = null;
        this.portfolioMineElevatorCoordinator?.Invalidate(reasonCode);
        this.portfolioMineElevatorCoordinator = null;
        this.portfolioMineElevatorAdapter?.DiscardPendingForInvalidation();
        this.portfolioMineElevatorAdapter = null;
        this.Monitor.Log($"GameBuddy cleared Portfolio observe binding: {reasonCode}.", LogLevel.Warn);
    }
}
