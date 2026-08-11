using System.Text.Json;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void TryInitializePortfolioBinding()
    {
        PortfolioConfig? config = this.config.Portfolio;
        if (config is not { Enable: true })
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
        if (!PortfolioLocalPlayerBinding.IsPinnedRuntimeVersion(Game1.version, Game1.versionBuildNumber))
        {
            this.InvalidatePortfolioState("portfolio_target_version_mismatch");
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
                Game1.version,
                Game1.versionBuildNumber,
                this.portfolioBindingGeneration,
                this.portfolioLastObservedRevision < 0 ? 0 : this.portfolioLastObservedRevision,
                Game1.ticks);
            this.portfolioLastObservedRevision = -1;
            this.portfolioBridgeSession = new PortfolioBridgeSession(this.portfolioBinding, config.BridgeToken);
            this.portfolioPipeBridge = config.EnableObserveBridge ? new PortfolioLocalPipeBridge(config.PipeName) : null;
            this.Monitor.Log($"GameBuddy Portfolio binding opened for native local Player {config.LocalPlayerId}; observe_only=true; generation={this.portfolioBinding.BindingGeneration}.", LogLevel.Info);
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
                    this.Monitor.Log("GameBuddy discarded Portfolio bridge response after disconnect or backpressure.", LogLevel.Warn);
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
        if (!PortfolioLocalPlayerBinding.IsPinnedRuntimeVersion(Game1.version, Game1.versionBuildNumber)
            || !binding.MatchesRuntimeVersion(Game1.version, Game1.versionBuildNumber))
        {
            reasonCode = "portfolio_target_version_mismatch";
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
        this.Monitor.Log($"GameBuddy cleared Portfolio observe binding: {reasonCode}.", LogLevel.Warn);
    }
}
