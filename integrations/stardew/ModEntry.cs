using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewModdingAPI.Utilities;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// Embodiment entry point. State is isolated per local split-screen player.
/// The configured PlayerId selects the one real local Farmhand GameBuddy may
/// control; no state is created for the human player's screen.
/// </summary>
public sealed class ModEntry : Mod
{
    private readonly PerScreen<ScreenEmbodimentState> screenStates = new(() => new ScreenEmbodimentState());
    private ModConfig config = new();

    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        helper.Events.GameLoop.GameLaunched += this.OnGameLaunched;
        helper.Events.GameLoop.SaveLoaded += this.OnSaveLoaded;
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.DayStarted += this.OnDayStarted;
        helper.Events.Player.Warped += this.OnWarped;
        helper.Events.GameLoop.Saving += this.OnSaving;
        helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;

        helper.ConsoleCommands.Add("gamebuddy_farmhands", "List authoritative local-co-op player and Farmhand identities without changing game state.", this.FarmhandsCommand);
        helper.ConsoleCommands.Add("gamebuddy_status", "Print the configured AI Farmhand's authoritative snapshot on its local screen.", this.StatusCommand);
        helper.ConsoleCommands.Add("gamebuddy_trace", "Print bounded AI Farmhand directive/route/body execution trace evidence.", this.TraceCommand);
        helper.ConsoleCommands.Add("gamebuddy_move_fixture", "Phase 1 local-only movement fixture: gamebuddy_move_fixture <tile-x> <tile-y> <request-id>.", this.MoveFixtureCommand);
        helper.ConsoleCommands.Add("gamebuddy_equip_tool_fixture", "Phase 1 local-only native mechanic fixture: gamebuddy_equip_tool_fixture <inventory-slot> <request-id>.", this.EquipToolFixtureCommand);
        helper.ConsoleCommands.Add("gamebuddy_cancel", "Cancel the active local AI Farmhand GameBuddy execution.", this.CancelCommand);

        this.Monitor.Log("GameBuddy embodiment loaded; split-screen state is isolated and no remote Farmer construction or host-side control is available.", LogLevel.Info);
    }

    private void OnGameLaunched(object? sender, GameLaunchedEventArgs e)
    {
        this.Monitor.Log("GameBuddy health: SMAPI lifecycle hooks are available.", LogLevel.Trace);
    }

    private void FarmhandsCommand(string command, string[] args)
    {
        if (!Context.IsWorldReady)
        {
            this.Monitor.Log("GameBuddy cannot list Farmhands until a save is loaded.", LogLevel.Warn);
            return;
        }

        foreach (Farmer farmer in Game1.getAllFarmers().OrderBy(farmer => farmer.UniqueMultiplayerID))
        {
            string role = farmer.UniqueMultiplayerID == Game1.MasterPlayer.UniqueMultiplayerID ? "host" : "farmhand";
            string location = farmer.currentLocation?.NameOrUniqueName ?? "unknown";
            this.Monitor.Log(
                $"GameBuddy farmer: role={role}, player_id={farmer.UniqueMultiplayerID}, name={farmer.Name}, location={location}, tile={farmer.Tile}, current_screen_player={farmer.UniqueMultiplayerID == Game1.player.UniqueMultiplayerID}.",
                LogLevel.Info);
        }
    }

    private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
    {
        ScreenEmbodimentState state = this.screenStates.Value;
        this.ClearState(state, "save_loaded");
        if (!this.IsConfiguredAiScreen(out Farmer? localPlayer, out string reason))
        {
            this.Monitor.Log($"GameBuddy ignored local screen {Context.ScreenId}: {reason}.", LogLevel.Trace);
            return;
        }

        state.Executions = new ExecutionManager(this.Monitor, receipt => this.PublishReceipt(state, receipt), this.config.EnabledActionSet);
        bool saveScopeMatches = this.config.SaveId == Game1.uniqueIDForThisGame.ToString();
        bool worldScopeMatches = this.config.WorldId == Game1.MasterPlayer.UniqueMultiplayerID.ToString();
        bool scopeMatchesWorld = saveScopeMatches && worldScopeMatches;
        state.BridgeSession = this.config.HasValidLocalBridgeConfiguration && scopeMatchesWorld
            ? new BridgeSession(state.Executions, new BridgeScope("stardew", this.config.SaveId, this.config.WorldId, this.config.PlayerId, this.config.CompanionId), this.config.BridgeToken, this.config.EnabledActionSet)
            : null;
        state.LocalPipeBridge = state.BridgeSession is null ? null : new LocalPipeBridge(this.config.PipeName);
        if (this.config.EnableLocalBridge && state.BridgeSession is null)
            this.Monitor.Log(this.config.HasValidLocalBridgeConfiguration
                ? "GameBuddy local bridge remains disabled: configured save/world scope does not bind to this AI Farmhand world."
                : "GameBuddy local bridge remains disabled: configuration must use opaque scope IDs and a 16+ character token.", LogLevel.Warn);
        else if (state.LocalPipeBridge is not null)
            this.Monitor.Log($"GameBuddy local named-pipe bridge started for AI Farmhand screen {Context.ScreenId}.", LogLevel.Info);

        this.Monitor.Log(
            $"GameBuddy bound configured AI Farmhand only: screen_id={Context.ScreenId}, farmhand_id={localPlayer!.UniqueMultiplayerID}, split_screen={Context.IsSplitScreen}, multiplayer={Context.IsMultiplayer}, main_player={Context.IsMainPlayer}, location={localPlayer.currentLocation?.NameOrUniqueName ?? "unknown"}.",
            LogLevel.Info);
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        if (!Context.IsWorldReady || !this.IsConfiguredAiScreen(out _, out _))
            return;

        ScreenEmbodimentState state = this.screenStates.Value;
        this.DrainLocalPipeBridge(state);
        state.Executions?.Update();
    }

    private void OnDayStarted(object? sender, DayStartedEventArgs e)
    {
        if (!this.TryGetAiState(out ScreenEmbodimentState state))
            return;
        ExecutionManager executions = state.Executions!;
        executions.InvalidateForLifecycle("day_started");
        this.PublishLifecycle(state, "connected", "day_started");
    }

    private void OnWarped(object? sender, WarpedEventArgs e)
    {
        if (this.TryGetAiState(out ScreenEmbodimentState state) && e.Player.UniqueMultiplayerID == Game1.player.UniqueMultiplayerID)
        {
            ExecutionManager executions = state.Executions!;
            executions.InvalidateForLifecycle("warped");
            this.PublishSemantic(state, "snapshot_changed", "warped");
        }
    }

    private void OnSaving(object? sender, SavingEventArgs e)
    {
        if (!this.TryGetAiState(out ScreenEmbodimentState state))
            return;
        ExecutionManager executions = state.Executions!;
        executions.InvalidateForLifecycle("saving");
        this.PublishLifecycle(state, "world_unavailable", "saving");
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
    {
        ScreenEmbodimentState state = this.screenStates.Value;
        if (state.Executions is not null)
        {
            state.Executions.InvalidateForLifecycle("returned_to_title");
            this.PublishLifecycle(state, "world_unavailable", "returned_to_title");
        }
        this.ClearState(state, "returned_to_title");
        this.Monitor.Log($"GameBuddy cleared local embodiment state for screen {Context.ScreenId}.", LogLevel.Trace);
    }

    private void StatusCommand(string command, string[] args)
    {
        if (!this.RequireAiWorld(out ScreenEmbodimentState state))
            return;
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(state.Executions!.CreateSnapshot(), BridgeProtocol.JsonOptions), LogLevel.Info);
    }

    private void TraceCommand(string command, string[] args)
    {
        if (!this.RequireAiWorld(out ScreenEmbodimentState state))
            return;
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(state.Executions!.Trace, BridgeProtocol.JsonOptions), LogLevel.Info);
    }

    private void MoveFixtureCommand(string command, string[] args)
    {
        if (!this.RequireAiWorld(out ScreenEmbodimentState state))
            return;
        if (args.Length != 3 || !int.TryParse(args[0], out int x) || !int.TryParse(args[1], out int y) || !IsOpaqueRequestId(args[2]))
        {
            this.Monitor.Log("Usage: gamebuddy_move_fixture <integer-tile-x> <integer-tile-y> <request-id>; request-id must be 1-64 letters, digits, _ or -.", LogLevel.Warn);
            return;
        }
        LocalExecutionReceipt receipt = state.Executions!.RequestLocalMove(args[2], new Vector2(x, y));
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    private void EquipToolFixtureCommand(string command, string[] args)
    {
        if (!this.RequireAiWorld(out ScreenEmbodimentState state))
            return;
        if (args.Length != 2 || !int.TryParse(args[0], out int slot) || !IsOpaqueRequestId(args[1]))
        {
            this.Monitor.Log("Usage: gamebuddy_equip_tool_fixture <inventory-slot> <request-id>; request-id must be 1-64 letters, digits, _ or -.", LogLevel.Warn);
            return;
        }
        LocalExecutionReceipt receipt = state.Executions!.RequestLocalEquipTool(args[1], slot);
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    private void CancelCommand(string command, string[] args)
    {
        if (!this.RequireAiWorld(out ScreenEmbodimentState state))
            return;
        LocalExecutionReceipt receipt = state.Executions!.CancelActiveForFixture("local_console_cancel");
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    private void DrainLocalPipeBridge(ScreenEmbodimentState state)
    {
        if (state.LocalPipeBridge is null || state.BridgeSession is null)
            return;
        for (int index = 0; index < 8 && state.LocalPipeBridge.TryDequeueInbound(out PipeInbound inbound); index++)
        {
            try
            {
                using System.Text.Json.JsonDocument document = System.Text.Json.JsonDocument.Parse(inbound.Json);
                if (document.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object
                    || !document.RootElement.TryGetProperty("type", out System.Text.Json.JsonElement typeElement)
                    || typeElement.ValueKind != System.Text.Json.JsonValueKind.String)
                {
                    this.Monitor.Log("GameBuddy rejected malformed local bridge envelope.", LogLevel.Warn);
                    continue;
                }
                string? correlationId = document.RootElement.TryGetProperty("correlationId", out System.Text.Json.JsonElement correlationElement)
                    && correlationElement.ValueKind == System.Text.Json.JsonValueKind.String ? correlationElement.GetString() : null;
                string? response = typeElement.GetString() switch
                {
                    "hello" => this.HandleHello(state, inbound.Generation, inbound.Json),
                    "observe_request" => this.HandleObserve(state, inbound.Generation, inbound.Json),
                    "execution_request" => this.HandleExecute(state, inbound.Generation, inbound.Json),
                    "cancel_request" => this.HandleCancel(state, inbound.Generation, inbound.Json),
                    _ => this.SerializeError(state, correlationId, "unknown_message_type"),
                };
                if (response is not null && !state.LocalPipeBridge.TryEnqueueOutbound(inbound.Generation, response))
                    this.Monitor.Log("GameBuddy discarded local bridge response after connection closed or backpressure.", LogLevel.Warn);
            }
            catch (System.Text.Json.JsonException)
            {
                this.Monitor.Log("GameBuddy rejected malformed local bridge JSON.", LogLevel.Warn);
            }
            catch (Exception exception)
            {
                this.Monitor.Log($"GameBuddy rejected local bridge request: {exception.GetType().Name}.", LogLevel.Warn);
            }
        }
    }

    private void PublishReceipt(ScreenEmbodimentState state, LocalExecutionReceipt receipt)
    {
        if (state.LocalPipeBridge is null || state.BridgeSession is null)
            return;
        long generation = state.LocalPipeBridge.CurrentGeneration;
        if (generation != 0 && state.BridgeSession.TryCreateReceiptEvent(generation, receipt, out string json)
            && !state.LocalPipeBridge.TryEnqueueOutbound(generation, json))
            this.Monitor.Log("GameBuddy dropped receipt event due to closed/backpressured bridge.", LogLevel.Warn);
    }

    private void PublishSemantic(ScreenEmbodimentState state, string kind, string reasonCode)
    {
        if (state.LocalPipeBridge is null || state.BridgeSession is null)
            return;
        long generation = state.LocalPipeBridge.CurrentGeneration;
        string correlationId = Guid.NewGuid().ToString("N");
        if (generation != 0 && state.BridgeSession.TryCreateSemanticEvent(generation, kind, correlationId, reasonCode, out string json)
            && !state.LocalPipeBridge.TryEnqueueOutbound(generation, json))
            this.Monitor.Log("GameBuddy dropped semantic event due to closed/backpressured bridge.", LogLevel.Warn);
    }

    private void PublishLifecycle(ScreenEmbodimentState state, string lifecycleState, string reasonCode)
    {
        if (state.LocalPipeBridge is null || state.BridgeSession is null)
            return;
        long generation = state.LocalPipeBridge.CurrentGeneration;
        string correlationId = Guid.NewGuid().ToString("N");
        if (generation != 0 && state.BridgeSession.TryCreateLifecycleEvent(generation, lifecycleState, correlationId, reasonCode, out string json)
            && !state.LocalPipeBridge.TryEnqueueOutbound(generation, json))
            this.Monitor.Log("GameBuddy dropped lifecycle event due to closed/backpressured bridge.", LogLevel.Warn);
    }

    private string? SerializeError(ScreenEmbodimentState state, string? correlationId, string reasonCode) => state.BridgeSession is not null && BridgeProtocol.TrySerialize(state.BridgeSession.CreateError(correlationId, reasonCode), out string json, out _) ? json : null;

    private string? HandleHello(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeHello, BridgeHelloAck>(state,
        System.Text.Json.JsonSerializer.Deserialize<BridgeEnvelope<BridgeHello>>(json, BridgeProtocol.JsonOptions),
        (BridgeEnvelope<BridgeHello> request, out BridgeEnvelope<BridgeHelloAck>? response, out string reason) => state.BridgeSession!.TryAuthenticate(generation, request, out response, out reason), out _);

    private string? HandleObserve(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeObserveRequest, BridgeSnapshot>(state,
        System.Text.Json.JsonSerializer.Deserialize<BridgeEnvelope<BridgeObserveRequest>>(json, BridgeProtocol.JsonOptions),
        (BridgeEnvelope<BridgeObserveRequest> request, out BridgeEnvelope<BridgeSnapshot>? response, out string reason) => state.BridgeSession!.TryObserve(generation, request, out response, out reason), out _);

    private string? HandleExecute(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeExecutionRequest, BridgeReceipt>(state,
        System.Text.Json.JsonSerializer.Deserialize<BridgeEnvelope<BridgeExecutionRequest>>(json, BridgeProtocol.JsonOptions),
        (BridgeEnvelope<BridgeExecutionRequest> request, out BridgeEnvelope<BridgeReceipt>? response, out string reason) => state.BridgeSession!.TryExecute(generation, request, out response, out reason), out _);

    private string? HandleCancel(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeCancelRequest, BridgeReceipt>(state,
        System.Text.Json.JsonSerializer.Deserialize<BridgeEnvelope<BridgeCancelRequest>>(json, BridgeProtocol.JsonOptions),
        (BridgeEnvelope<BridgeCancelRequest> request, out BridgeEnvelope<BridgeReceipt>? response, out string reason) => state.BridgeSession!.TryCancel(generation, request, out response, out reason), out _);

    private string? SerializeBridgeResponse<TRequest, TResponse>(
        ScreenEmbodimentState state,
        BridgeEnvelope<TRequest>? request,
        TryBridgeRequest<TRequest, TResponse> handler,
        out string reasonCode)
    {
        reasonCode = "invalid_envelope";
        if (request is null)
            return this.SerializeError(state, null, reasonCode);
        if (!handler(request, out BridgeEnvelope<TResponse>? response, out reasonCode) || response is null)
            return this.SerializeError(state, request.CorrelationId, reasonCode);
        return BridgeProtocol.TrySerialize(response, out string json, out _) ? json : this.SerializeError(state, request.CorrelationId, "response_serialization_failed");
    }

    private bool TryGetAiState(out ScreenEmbodimentState state)
    {
        state = null!;
        if (!Context.IsWorldReady || !this.IsConfiguredAiScreen(out _, out _))
            return false;
        ScreenEmbodimentState candidate = this.screenStates.Value;
        if (candidate.Executions is null)
            return false;
        state = candidate;
        return true;
    }

    private bool RequireAiWorld(out ScreenEmbodimentState state)
    {
        if (!this.TryGetAiState(out state))
        {
            this.Monitor.Log("GameBuddy diagnostics are available only on the configured AI Farmhand's local screen after its world is loaded.", LogLevel.Warn);
            return false;
        }
        return true;
    }

    private bool IsConfiguredAiScreen(out Farmer? localPlayer, out string reasonCode)
    {
        localPlayer = null;
        reasonCode = "world_not_ready";
        if (!Context.IsWorldReady || Game1.player is null)
            return false;
        localPlayer = Game1.player;
        if (this.config.PlayerId != localPlayer.UniqueMultiplayerID.ToString())
        {
            reasonCode = "screen_player_id_does_not_match_configured_ai_farmhand";
            return false;
        }
        reasonCode = "configured_ai_farmhand";
        return true;
    }

    private void ClearState(ScreenEmbodimentState state, string reasonCode)
    {
        state.Executions?.InvalidateForLifecycle(reasonCode);
        state.LocalPipeBridge?.Dispose();
        state.LocalPipeBridge = null;
        state.BridgeSession = null;
        state.Executions = null;
    }

    private delegate bool TryBridgeRequest<TRequest, TResponse>(BridgeEnvelope<TRequest> request, out BridgeEnvelope<TResponse>? response, out string reasonCode);
    private static bool IsOpaqueRequestId(string value) => value.Length is >= 1 and <= 64 && value.All(character => (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');

    private sealed class ScreenEmbodimentState
    {
        internal ExecutionManager? Executions { get; set; }
        internal BridgeSession? BridgeSession { get; set; }
        internal LocalPipeBridge? LocalPipeBridge { get; set; }
    }
}
