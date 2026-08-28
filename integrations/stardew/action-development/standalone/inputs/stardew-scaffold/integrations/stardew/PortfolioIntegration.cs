using System.Text.Json;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private PortfolioSleepDayCoordinator? portfolioSleepDayCoordinator;
    private PortfolioMineElevatorActionCoordinator? portfolioMineElevatorCoordinator;
    private PortfolioMineElevatorSemanticAdapter? portfolioMineElevatorAdapter;
    private PortfolioMineEntryActionCoordinator? portfolioMineEntryCoordinator;
    private PortfolioMineEntrySemanticAdapter? portfolioMineEntryAdapter;
    private PortfolioMineLadderActionCoordinator? portfolioMineLadderCoordinator;
    private PortfolioMineLadderSemanticAdapter? portfolioMineLadderAdapter;
    private PortfolioSkipEventActionCoordinator? portfolioSkipEventCoordinator;
    private PortfolioSkipEventSemanticAdapter? portfolioSkipEventAdapter;
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
        if (!this.TryPreparePortfolioMineEntryGivenFixture())
            return;
        if (!this.TryPreparePortfolioMineLadderGivenFixture())
            return;
        if (!this.TryPreparePortfolioMineElevatorGivenFixture())
            return;
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
                    ?? throw new InvalidOperationException("portfolio_mine_elevator_not_armed"),
                executionId => this.portfolioMineElevatorCoordinator?.ArmNativeTransition(executionId) == true);
            this.portfolioMineElevatorCoordinator = new PortfolioMineElevatorActionCoordinator(this.portfolioMineElevatorAdapter);
            this.portfolioMineEntryAdapter = new PortfolioMineEntrySemanticAdapter(
                config,
                () => this.IsPortfolioBindingCurrent(out _),
                () => ++this.portfolioLastObservedRevision,
                observation => this.portfolioMineEntryCoordinator?.ObserveTransitionStarted(observation) == true,
                observation => this.portfolioMineEntryCoordinator?.ObservePostcondition(observation)
                    ?? throw new InvalidOperationException("portfolio_enter_mine_not_armed"),
                (requestId, traceId, executionId, reasonCode, revision, scope) => this.portfolioMineEntryCoordinator?.Fail(
                    requestId, traceId, executionId, reasonCode, revision, scope)
                    ?? throw new InvalidOperationException("portfolio_enter_mine_not_armed"),
                executionId => this.portfolioMineEntryCoordinator?.ArmNativeTransition(executionId) == true);
            this.portfolioMineEntryCoordinator = new PortfolioMineEntryActionCoordinator(this.portfolioMineEntryAdapter);
            this.portfolioMineLadderAdapter = new PortfolioMineLadderSemanticAdapter(
                config,
                () => this.IsPortfolioBindingCurrent(out _),
                () => ++this.portfolioLastObservedRevision,
                observation => this.portfolioMineLadderCoordinator?.ObserveTransitionStarted(observation) == true,
                observation => this.portfolioMineLadderCoordinator?.ObservePostcondition(observation)
                    ?? throw new InvalidOperationException("portfolio_mine_ladder_not_armed"),
                (requestId, traceId, executionId, reasonCode, revision, scope) => this.portfolioMineLadderCoordinator?.Fail(
                    requestId, traceId, executionId, reasonCode, revision, scope)
                    ?? throw new InvalidOperationException("portfolio_mine_ladder_not_armed"),
                executionId => this.portfolioMineLadderCoordinator?.ArmNativeTransition(executionId) == true);
            this.portfolioMineLadderCoordinator = new PortfolioMineLadderActionCoordinator(this.portfolioMineLadderAdapter);
            this.portfolioSkipEventAdapter = new PortfolioSkipEventSemanticAdapter(
                config,
                () => this.IsPortfolioBindingCurrent(out _),
                () => ++this.portfolioLastObservedRevision,
                observation => this.portfolioSkipEventCoordinator?.ObserveNativeSkip(observation) == true,
                observation => this.portfolioSkipEventCoordinator?.ObservePostcondition(observation)
                    ?? throw new InvalidOperationException("portfolio_skip_event_not_armed"),
                (requestId, traceId, executionId, reasonCode, revision, scope) => this.portfolioSkipEventCoordinator?.Fail(
                    requestId, traceId, executionId, reasonCode, revision, scope)
                    ?? throw new InvalidOperationException("portfolio_skip_event_not_armed"));
            this.portfolioSkipEventCoordinator = new PortfolioSkipEventActionCoordinator(this.portfolioSkipEventAdapter);
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
        if (this.portfolioPipeBridge.TryConsumeDisconnect(out PortfolioPipeDisconnect? disconnect) && disconnect is not null)
        {
            // The worker only records transport facts; this game-thread
            // transfer is the sole place allowed to arm the one-shot bootstrap
            // successor. Every ordinary authenticated disconnect remains an
            // immediate fail-closed clear.
            bool activeExecution = (this.portfolioSleepDayCoordinator?.HasActiveExecution ?? false)
                || (this.portfolioMineElevatorCoordinator?.HasActiveExecution ?? false)
                || (this.portfolioMineEntryCoordinator?.HasActiveExecution ?? false)
                || (this.portfolioMineLadderCoordinator?.HasActiveExecution ?? false)
                || (this.portfolioSkipEventCoordinator?.HasActiveExecution ?? false);
            bool bootstrapDisconnectAccepted = this.portfolioBridgeSession!.TryConsumeBootstrapDisconnect(
                disconnect.Generation,
                activeExecution,
                out string bootstrapDisconnectReason);
            this.Monitor.Log(
                $"GameBuddy Portfolio bootstrap disconnect decision: generation={disconnect.Generation}; active_execution={activeExecution}; accepted={bootstrapDisconnectAccepted}; reason={bootstrapDisconnectReason}.",
                LogLevel.Debug);
            if (!bootstrapDisconnectAccepted)
            {
                this.ClearPortfolioState(disconnect.ReasonCode);
                return;
            }
            return;
        }
        this.portfolioMineElevatorAdapter?.Watchdog(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        // Direct entry has no private approach, but its armed native transition
        // still needs deadline settlement if its exact native continuation never arrives.
        this.portfolioMineEntryAdapter?.Watchdog(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        this.portfolioMineLadderAdapter?.Watchdog(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        this.portfolioSkipEventAdapter?.Watchdog(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        this.portfolioSkipEventAdapter?.ObserveAfterEventUpdate();
        this.DrainPortfolioMineElevatorTerminalDeliveries();
        this.DrainPortfolioMineEntryTerminalDeliveries();
        this.DrainPortfolioMineLadderTerminalDeliveries();
        this.DrainPortfolioSkipEventTerminalDeliveries();
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
        // A new pipe generation may connect before the game thread consumes
        // the prior bootstrap disconnect. Its queued strict hello is admitted
        // only after that one-shot handoff is armed below. Do not clear the
        // binding merely because the background worker has already advanced
        // CurrentGeneration to the expected successor.
        bool awaitingBootstrapDisconnect = this.portfolioBridgeSession.IsBootstrapHandoffAwaitingDisconnect;
        // The pipe worker allocates its successor generation before the game
        // thread sees the bootstrap disconnect. That successor is necessarily
        // bootstrapGeneration + 1; any other new generation is a protocol
        // fault and clears as before.
        bool queuedExpectedSuccessor = awaitingBootstrapDisconnect
            && this.portfolioBridgeSession.IsBootstrapSuccessorGeneration(generation);
        bool initialBootstrapGeneration = this.portfolioBridgeSession.CanAcceptInitialGeneration(generation);
        if (!initialBootstrapGeneration && !queuedExpectedSuccessor
            && this.portfolioBridgeSession.IsExpectedStrictGeneration(generation) == false
            && this.portfolioBridgeSession.IsBootstrapGeneration(generation) == false
            && this.portfolioBridgeSession.IsAuthenticatedGeneration(generation) == false)
        {
            this.ClearPortfolioState("portfolio_bridge_generation_unexpected");
            return;
        }
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
                    if (!this.portfolioBridgeSession!.IsAuthenticatedGeneration(inbound.Generation))
                    {
                        this.ClearPortfolioState("portfolio_bootstrap_not_allowed");
                        return;
                    }
                    response = this.SerializePortfolioError(null, "invalid_envelope");
                }
                else
                {
                    string? inboundType = typeElement.GetString();
                    // A successor is strictly hello-only until authentication;
                    // observe/action traffic in this window is a protocol fault,
                    // not a request that may receive a normal error response.
                    if ((this.portfolioBridgeSession!.IsBootstrapGeneration(inbound.Generation)
                            && inboundType != "bootstrap_hello")
                        || (inboundType == "bootstrap_hello"
                            && (this.portfolioBridgeSession.IsBootstrapGeneration(inbound.Generation)
                                || this.portfolioBridgeSession.IsAuthenticatedGeneration(inbound.Generation)
                                || this.portfolioBridgeSession.IsExpectedStrictGeneration(inbound.Generation))))
                    {
                        this.ClearPortfolioState("portfolio_bootstrap_not_allowed");
                        return;
                    }
                    if (this.portfolioBridgeSession!.IsExpectedStrictGeneration(inbound.Generation)
                        && inboundType != "hello")
                    {
                        this.ClearPortfolioState("portfolio_bootstrap_not_allowed");
                        return;
                    }
                    string? correlationId = document.RootElement.TryGetProperty("correlationId", out JsonElement correlationElement)
                        && correlationElement.ValueKind == JsonValueKind.String ? correlationElement.GetString() : null;
                    response = inboundType switch
                    {
                        "bootstrap_hello" => this.HandlePortfolioBootstrapHello(inbound.Generation, inbound.Json),
                        "hello" => this.HandlePortfolioHello(inbound.Generation, inbound.Json),
                        "observe_request" => this.HandlePortfolioObserve(inbound.Generation, inbound.Json),
                        "sleep_day_request" => this.HandlePortfolioSleepDay(inbound.Generation, inbound.Json),
                        "sleep_day_cancel_request" => this.HandlePortfolioSleepDayCancel(inbound.Generation, inbound.Json),
                        "mine_elevator_probe_request" => this.HandlePortfolioMineElevatorProbe(inbound.Generation, inbound.Json),
                        "mine_elevator_fresh_floor_request" => this.HandlePortfolioMineElevatorFreshFloor(inbound.Generation, inbound.Json),
                        "mine_elevator_request" => this.HandlePortfolioMineElevator(inbound.Generation, inbound.Json),
                        "mine_elevator_cancel_request" => this.HandlePortfolioMineElevatorCancel(inbound.Generation, inbound.Json),
                        "mine_ladder_probe_request" => this.HandlePortfolioMineLadderProbe(inbound.Generation, inbound.Json),
                        "mine_ladder_fresh_floor_request" => this.HandlePortfolioMineLadderFreshFloor(inbound.Generation, inbound.Json),
                        "mine_ladder_request" => this.HandlePortfolioMineLadder(inbound.Generation, inbound.Json),
                        "mine_ladder_cancel_request" => this.HandlePortfolioMineLadderCancel(inbound.Generation, inbound.Json),
                        "enter_mine_probe_request" => this.HandlePortfolioMineEntryProbe(inbound.Generation, inbound.Json),
                        "enter_mine_fresh_floor_request" => this.HandlePortfolioMineEntryFreshFloor(inbound.Generation, inbound.Json),
                        "enter_mine_request" => this.HandlePortfolioMineEntry(inbound.Generation, inbound.Json),
                        "enter_mine_cancel_request" => this.HandlePortfolioMineEntryCancel(inbound.Generation, inbound.Json),
                        "skip_event_probe_request" => this.HandlePortfolioSkipEventProbe(inbound.Generation, inbound.Json),
                        "skip_event_request" => this.HandlePortfolioSkipEvent(inbound.Generation, inbound.Json),
                        "skip_event_cancel_request" => this.HandlePortfolioSkipEventCancel(inbound.Generation, inbound.Json),
                        _ => this.SerializePortfolioError(correlationId, "portfolio_message_type_rejected"),
                    };
                }
            }
            catch (JsonException)
            {
                if (this.portfolioBridgeSession?.IsAuthenticatedGeneration(inbound.Generation) != true)
                {
                    this.ClearPortfolioState("portfolio_bootstrap_not_allowed");
                    return;
                }
                response = this.SerializePortfolioError(null, "invalid_json");
            }
            catch (Exception exception)
            {
                this.Monitor.Log($"GameBuddy rejected Portfolio bridge request: {exception.GetType().Name}.", LogLevel.Warn);
                if (this.portfolioBridgeSession?.IsAuthenticatedGeneration(inbound.Generation) != true)
                {
                    this.ClearPortfolioState("portfolio_bootstrap_not_allowed");
                    return;
                }
                response = this.SerializePortfolioError(null, "invalid_request");
            }
            if (this.portfolioBinding is null || this.portfolioBridgeSession is null || this.portfolioPipeBridge is null)
                return;
            if (response is not null)
            {
                if (this.portfolioBridgeSession is not null
                    && this.portfolioBridgeSession.IsExpectedStrictGeneration(inbound.Generation)
                    && !this.portfolioBridgeSession.IsAuthenticatedGeneration(inbound.Generation))
                {
                    this.ClearPortfolioState("portfolio_bootstrap_not_allowed");
                    return;
                }
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
                    if (IsPortfolioMineAcceptedPhaseResponse(response))
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

    private string? HandlePortfolioBootstrapHello(long generation, string json)
    {
        if (this.portfolioBridgeSession is null)
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_envelope");
        if (!this.portfolioBridgeSession.TryBootstrapHello(generation, json, out PortfolioEnvelope<PortfolioHelloAck>? response, out string reasonCode) || response is null)
        {
            if (this.portfolioBridgeSession.IsExpectedStrictGeneration(generation)
                || this.portfolioBridgeSession.HasBootstrapHandoff)
                this.ClearPortfolioState("portfolio_bootstrap_not_allowed");
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        }
        return PortfolioBridgeProtocol.TrySerialize(response with { Type = "bootstrap_hello_ack" }, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(response.CorrelationId, "response_serialization_failed");
    }

    private string? HandlePortfolioHello(long generation, string json)
    {
        PortfolioEnvelope<PortfolioHello>? request = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioHello>>(json, PortfolioBridgeProtocol.JsonOptions);
        if (request is null || this.portfolioBridgeSession is null)
            return this.SerializePortfolioError(null, "invalid_envelope");
        if (!this.portfolioBridgeSession.TryAuthenticate(generation, request, out PortfolioEnvelope<PortfolioHelloAck>? response, out string reasonCode) || response is null)
        {
            if (this.portfolioBridgeSession.IsExpectedStrictGeneration(generation))
                this.ClearPortfolioState("portfolio_bootstrap_not_allowed");
            return this.SerializePortfolioError(request.CorrelationId, reasonCode);
        }
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

    private string? HandlePortfolioMineLadderProbe(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineLadderAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_mine_ladder_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryProbeMineLadder(generation, json, this.portfolioMineLadderAdapter,
                this.portfolioLastObservedRevision,
                out PortfolioEnvelope<PortfolioMineLadderProbe>? response, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return response is not null && PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private string? HandlePortfolioMineLadderFreshFloor(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineLadderCoordinator is null
            || this.portfolioMineLadderAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_mine_ladder_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        long freshRevision = this.portfolioLastObservedRevision + 1;
        if (!this.portfolioBridgeSession.TryReadMineLadderFreshFloor(generation, json, this.portfolioMineLadderCoordinator,
                this.portfolioMineLadderAdapter, freshRevision,
                out PortfolioEnvelope<PortfolioMineLadderFreshFloor>? response, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        this.portfolioLastObservedRevision = freshRevision;
        return response is not null && PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private string? HandlePortfolioMineLadder(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineLadderCoordinator is null
            || this.portfolioMineLadderAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_mine_ladder_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryMineLadder(generation, json, this.portfolioMineLadderCoordinator,
                this.portfolioMineLadderAdapter, this.portfolioLastObservedRevision,
                out PortfolioEnvelope<PortfolioMineLadderActionReceipt>? response,
                out PortfolioMineLadderActionPhase? phase, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        if (phase is not null)
        {
            PortfolioEnvelope<PortfolioMineLadderActionPhase> phaseEnvelope = new(
                PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), TryReadPortfolioCorrelationId(json) ?? Guid.NewGuid().ToString("N"),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), this.portfolioBinding.ToScope(), "mine_ladder_phase", phase);
            return PortfolioBridgeProtocol.TrySerialize(phaseEnvelope, out string phaseSerialized, out _)
                ? phaseSerialized
                : this.SerializePortfolioError(phaseEnvelope.CorrelationId, "response_serialization_failed");
        }
        return response is not null && PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private void DrainPortfolioMineLadderTerminalDeliveries()
    {
        if (this.portfolioMineLadderCoordinator is null || this.portfolioBridgeSession is null || this.portfolioPipeBridge is null)
            return;
        long generation = this.portfolioPipeBridge.CurrentGeneration;
        if (generation == 0 || !this.portfolioBridgeSession.IsAuthenticatedGeneration(generation))
            return;
        for (int index = 0; index < 8 && this.portfolioMineLadderCoordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? delivery); index++)
        {
            bool completionFailed = false;
            if (delivery is not null && this.portfolioMineLadderCoordinator.TryCompleteTerminalDelivery(delivery, generation, out completionFailed))
                continue;
            if (completionFailed)
            {
                this.InvalidatePortfolioState("portfolio_bridge_disconnected");
                return;
            }
            if (delivery is not null && this.portfolioMineLadderCoordinator.IsTerminalDeliveryPending(delivery))
                break;
            if (delivery is null || !delivery.Receipt.IsStructurallyTerminal)
            {
                if (delivery is not null)
                    this.portfolioMineLadderCoordinator.TryAcknowledgeTerminalDelivery(delivery);
                continue;
            }
            PortfolioEnvelope<PortfolioMineLadderActionReceipt> envelope = new(
                PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), delivery.CorrelationId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), delivery.Scope, "mine_ladder_receipt", delivery.Receipt);
            if (!PortfolioBridgeProtocol.TrySerialize(envelope, out string serialized, out _))
            {
                this.InvalidatePortfolioState("response_serialization_failed");
                return;
            }
            // Peek first: a terminal receipt remains owned by the coordinator
            // until this exact connection generation accepts it. Never replay it
            // into a later generation after a disconnect or backpressure fault.
            if (!this.portfolioPipeBridge.TryEnqueueOutbound(generation, serialized, out PortfolioPipeOutboundCompletion completion)
                || !this.portfolioMineLadderCoordinator.TryArmTerminalDelivery(delivery, completion))
            {
                this.InvalidatePortfolioState("portfolio_bridge_disconnected");
                return;
            }
            // Do not acknowledge on enqueue. The next game-thread update polls
            // the generation-bound completion after WriteFrameAsync + FlushAsync.
            break;
        }
    }

    private string? HandlePortfolioMineLadderCancel(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineLadderCoordinator is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_mine_ladder_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryCancelMineLadder(generation, json, this.portfolioMineLadderCoordinator,
                out PortfolioEnvelope<PortfolioMineLadderActionReceipt>? response, out string reasonCode) || response is null)
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(response.CorrelationId, "response_serialization_failed");
    }

    private string? HandlePortfolioMineEntryProbe(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineEntryAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_enter_mine_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryProbeMineEntry(generation, json, this.portfolioMineEntryAdapter,
                this.portfolioLastObservedRevision,
                out PortfolioEnvelope<PortfolioMineEntryProbe>? response, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return response is not null && PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private string? HandlePortfolioMineEntryFreshFloor(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineEntryCoordinator is null
            || this.portfolioMineEntryAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_enter_mine_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        long freshRevision = this.portfolioLastObservedRevision + 1;
        if (!this.portfolioBridgeSession.TryReadMineEntryFreshFloor(generation, json, this.portfolioMineEntryCoordinator,
                this.portfolioMineEntryAdapter, freshRevision,
                out PortfolioEnvelope<PortfolioMineEntryFreshFloor>? response, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        this.portfolioLastObservedRevision = freshRevision;
        return response is not null && PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private string? HandlePortfolioMineEntry(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineEntryCoordinator is null
            || this.portfolioMineEntryAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_enter_mine_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryMineEntry(generation, json, this.portfolioMineEntryCoordinator,
                this.portfolioMineEntryAdapter, this.portfolioLastObservedRevision,
                out PortfolioEnvelope<PortfolioMineEntryActionReceipt>? response,
                out PortfolioMineEntryActionPhase? phase, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        if (phase is not null)
        {
            PortfolioEnvelope<PortfolioMineEntryActionPhase> phaseEnvelope = new(
                PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), TryReadPortfolioCorrelationId(json) ?? Guid.NewGuid().ToString("N"),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), this.portfolioBinding.ToScope(), "enter_mine_phase", phase);
            return PortfolioBridgeProtocol.TrySerialize(phaseEnvelope, out string phaseSerialized, out _)
                ? phaseSerialized
                : this.SerializePortfolioError(phaseEnvelope.CorrelationId, "response_serialization_failed");
        }
        return response is not null && PortfolioBridgeProtocol.TrySerialize(response, out string serialized, out _)
            ? serialized
            : this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private string? HandlePortfolioSkipEventProbe(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioSkipEventAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_skip_event_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SkipEventAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        long currentRevision = this.portfolioLastObservedRevision;
        if (!this.portfolioBridgeSession.TrySkipEventProbe(generation, json, this.portfolioSkipEventCoordinator!, this.portfolioSkipEventAdapter,
                currentRevision, out string? response, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return response ?? this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private string? HandlePortfolioSkipEvent(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioSkipEventCoordinator is null
            || this.portfolioSkipEventAdapter is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_skip_event_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SkipEventAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TrySkipEvent(generation, json, this.portfolioSkipEventCoordinator,
                this.portfolioSkipEventAdapter, this.portfolioLastObservedRevision,
                out string? response, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return response ?? this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private string? HandlePortfolioSkipEventCancel(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioSkipEventCoordinator is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_skip_event_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.SkipEventAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryCancelSkipEvent(generation, json, this.portfolioSkipEventCoordinator,
                this.portfolioSkipEventAdapter!, out string? response, out string reasonCode))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), reasonCode);
        return response ?? this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "response_serialization_failed");
    }

    private void DrainPortfolioSkipEventTerminalDeliveries()
    {
        if (this.portfolioSkipEventCoordinator is null || this.portfolioBridgeSession is null || this.portfolioPipeBridge is null)
            return;
        long generation = this.portfolioPipeBridge.CurrentGeneration;
        if (generation == 0 || !this.portfolioBridgeSession.IsAuthenticatedGeneration(generation))
            return;
        for (int index = 0; index < 8 && this.portfolioSkipEventCoordinator.TryPeekTerminalDelivery(out PortfolioSkipEventTerminalDelivery? delivery); index++)
        {
            bool completionFailed = false;
            if (delivery is not null && this.portfolioSkipEventCoordinator.TryCompleteTerminalDelivery(delivery, generation, out completionFailed))
                continue;
            if (completionFailed)
            {
                this.InvalidatePortfolioState("portfolio_bridge_disconnected");
                return;
            }
            if (delivery is not null && this.portfolioSkipEventCoordinator.IsTerminalDeliveryPending(delivery))
                break;
            if (delivery is null || !delivery.Receipt.IsStructurallyTerminal)
            {
                if (delivery is not null)
                    this.portfolioSkipEventCoordinator.TryAcknowledgeTerminalDelivery(delivery);
                continue;
            }
            PortfolioEnvelope<PortfolioSkipEventActionReceipt> envelope = new(
                PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), delivery.CorrelationId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), delivery.Scope, "skip_event_receipt", delivery.Receipt);
            if (!PortfolioBridgeProtocol.TrySerialize(envelope, out string serialized, out _))
            {
                this.InvalidatePortfolioState("response_serialization_failed");
                return;
            }
            if (!this.portfolioPipeBridge.TryEnqueueOutbound(generation, serialized, out PortfolioPipeOutboundCompletion completion)
                || !this.portfolioSkipEventCoordinator.TryArmTerminalDelivery(delivery, completion))
            {
                this.InvalidatePortfolioState("portfolio_bridge_disconnected");
                return;
            }
            break;
        }
    }

    private void DrainPortfolioMineEntryTerminalDeliveries()
    {
        if (this.portfolioMineEntryCoordinator is null || this.portfolioBridgeSession is null || this.portfolioPipeBridge is null)
            return;
        long generation = this.portfolioPipeBridge.CurrentGeneration;
        if (generation == 0 || !this.portfolioBridgeSession.IsAuthenticatedGeneration(generation))
            return;
        for (int index = 0; index < 8 && this.portfolioMineEntryCoordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? delivery); index++)
        {
            bool completionFailed = false;
            if (delivery is not null && this.portfolioMineEntryCoordinator.TryCompleteTerminalDelivery(delivery, generation, out completionFailed))
                continue;
            if (completionFailed)
            {
                this.InvalidatePortfolioState("portfolio_bridge_disconnected");
                return;
            }
            if (delivery is not null && this.portfolioMineEntryCoordinator.IsTerminalDeliveryPending(delivery))
                break;
            if (delivery is null || !delivery.Receipt.IsStructurallyTerminal)
            {
                if (delivery is not null)
                    this.portfolioMineEntryCoordinator.TryAcknowledgeTerminalDelivery(delivery);
                continue;
            }
            PortfolioEnvelope<PortfolioMineEntryActionReceipt> envelope = new(
                PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), delivery.CorrelationId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), delivery.Scope, "enter_mine_receipt", delivery.Receipt);
            if (!PortfolioBridgeProtocol.TrySerialize(envelope, out string serialized, out _))
            {
                this.InvalidatePortfolioState("response_serialization_failed");
                return;
            }
            // Peek first: a terminal receipt remains owned by the coordinator
            // until this exact connection generation accepts it. Never replay it
            // into a later generation after a disconnect or backpressure fault.
            if (!this.portfolioPipeBridge.TryEnqueueOutbound(generation, serialized, out PortfolioPipeOutboundCompletion completion)
                || !this.portfolioMineEntryCoordinator.TryArmTerminalDelivery(delivery, completion))
            {
                this.InvalidatePortfolioState("portfolio_bridge_disconnected");
                return;
            }
            // Do not acknowledge on enqueue. The next game-thread update polls
            // the generation-bound completion after WriteFrameAsync + FlushAsync.
            break;
        }
    }

    private string? HandlePortfolioMineEntryCancel(long generation, string json)
    {
        if (this.portfolioBridgeSession is null || this.portfolioMineEntryCoordinator is null || this.portfolioBinding is null)
            return this.SerializePortfolioError(null, "portfolio_enter_mine_not_armed");
        if (this.config.Portfolio is not { } config
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction))
            return this.SerializePortfolioError(TryReadPortfolioCorrelationId(json), "invalid_request");
        if (!this.portfolioBridgeSession.TryCancelMineEntry(generation, json, this.portfolioMineEntryCoordinator,
                out PortfolioEnvelope<PortfolioMineEntryActionReceipt>? response, out string reasonCode) || response is null)
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

    private static bool IsPortfolioMineAcceptedPhaseResponse(string json)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            return document.RootElement.TryGetProperty("type", out JsonElement type)
                && type.ValueKind == JsonValueKind.String
                && (type.GetString() == "mine_elevator_phase" || type.GetString() == "mine_ladder_phase" || type.GetString() == "enter_mine_phase" || type.GetString() == "skip_event_phase")
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
        this.portfolioMineEntryCoordinator?.Invalidate(reasonCode);
        this.portfolioMineEntryCoordinator = null;
        this.portfolioMineEntryAdapter?.DiscardPendingForInvalidation();
        this.portfolioMineEntryAdapter = null;
        this.portfolioMineLadderCoordinator?.Invalidate(reasonCode);
        this.portfolioMineLadderCoordinator = null;
        this.portfolioMineLadderAdapter?.DiscardPendingForInvalidation();
        this.portfolioMineLadderAdapter = null;
        this.portfolioSkipEventCoordinator?.Invalidate(reasonCode);
        this.portfolioSkipEventCoordinator = null;
        this.portfolioSkipEventAdapter?.DiscardPendingForInvalidation();
        this.portfolioSkipEventAdapter = null;
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
        this.portfolioMineEntryCoordinator?.Invalidate(reasonCode);
        this.portfolioMineEntryCoordinator = null;
        this.portfolioMineEntryAdapter?.DiscardPendingForInvalidation();
        this.portfolioMineEntryAdapter = null;
        this.portfolioMineLadderCoordinator?.Invalidate(reasonCode);
        this.portfolioMineLadderCoordinator = null;
        this.portfolioMineLadderAdapter?.DiscardPendingForInvalidation();
        this.portfolioMineLadderAdapter = null;
        this.portfolioSkipEventCoordinator?.Invalidate(reasonCode);
        this.portfolioSkipEventCoordinator = null;
        this.portfolioSkipEventAdapter?.DiscardPendingForInvalidation();
        this.portfolioSkipEventAdapter = null;
        this.Monitor.Log($"GameBuddy cleared Portfolio observe binding: {reasonCode}.", LogLevel.Warn);
    }
}
