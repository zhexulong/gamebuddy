using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// Embodiment entry point. All state belongs to the client that loaded this
/// Mod. The only actor it ever controls is this process' real Game1.player;
/// it never creates or inserts a Farmer into multiplayer collections.
/// </summary>
public sealed class ModEntry : Mod
{
    private ExecutionManager? executions;
    private ModConfig config = new();
    private BridgeSession? bridgeSession;
    private LocalPipeBridge? localPipeBridge;

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

        helper.ConsoleCommands.Add("gamebuddy_status", "Print the local native-player binding and authoritative snapshot.", this.StatusCommand);
        helper.ConsoleCommands.Add("gamebuddy_move_fixture", "Phase 1 local-only movement fixture: gamebuddy_move_fixture <tile-x> <tile-y> <request-id>.", this.MoveFixtureCommand);
        helper.ConsoleCommands.Add("gamebuddy_equip_tool_fixture", "Phase 1 local-only native mechanic fixture: gamebuddy_equip_tool_fixture <inventory-slot> <request-id>.", this.EquipToolFixtureCommand);
        helper.ConsoleCommands.Add("gamebuddy_approve_move_fixture", "Local player-policy fixture: approve exactly one bridge move target: gamebuddy_approve_move_fixture <tile-x> <tile-y>.", this.ApproveMoveFixtureCommand);
        helper.ConsoleCommands.Add("gamebuddy_cancel", "Cancel the active local GameBuddy execution.", this.CancelCommand);

        this.Monitor.Log("GameBuddy embodiment loaded; no remote Farmer construction or host-side control is available.", LogLevel.Info);
    }

    private void OnGameLaunched(object? sender, GameLaunchedEventArgs e)
    {
        this.Monitor.Log("GameBuddy health: SMAPI lifecycle hooks are available.", LogLevel.Trace);
    }

    private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
    {
        this.executions = new ExecutionManager(this.Monitor, this.PublishReceipt);
        Farmer localPlayer = Game1.player;
        // The configured opaque player scope must bind to the identity Stardew
        // actually assigned this client. A copied config for another Farmhand
        // therefore fails closed instead of observing/executing as the wrong one.
        bool playerScopeMatches = this.config.PlayerId == localPlayer.UniqueMultiplayerID.ToString();
        bool saveScopeMatches = this.config.SaveId == Game1.uniqueIDForThisGame.ToString();
        bool worldScopeMatches = this.config.WorldId == Game1.MasterPlayer.UniqueMultiplayerID.ToString();
        bool scopeMatchesWorld = playerScopeMatches && saveScopeMatches && worldScopeMatches;
        this.bridgeSession = this.config.HasValidLocalBridgeConfiguration && scopeMatchesWorld
            ? new BridgeSession(this.executions, new BridgeScope("stardew", this.config.SaveId, this.config.WorldId, this.config.PlayerId, this.config.CompanionId), this.config.BridgeToken)
            : null;
        this.localPipeBridge = this.bridgeSession is null ? null : new LocalPipeBridge(this.config.PipeName);
        if (this.config.EnableLocalBridge && this.bridgeSession is null)
            this.Monitor.Log(this.config.HasValidLocalBridgeConfiguration
                ? "GameBuddy local bridge remains disabled: configured save/world/player scope does not bind to this client-local Stardew world."
                : "GameBuddy local bridge remains disabled: configuration must use opaque scope IDs and a 16+ character token.", LogLevel.Warn);
        else if (this.localPipeBridge is not null)
            this.Monitor.Log("GameBuddy local named-pipe bridge started for this client-local Farmhand.", LogLevel.Info);
        this.Monitor.Log(
            $"GameBuddy bound only local Game1.player: farmhand_id={localPlayer.UniqueMultiplayerID}, multiplayer={Context.IsMultiplayer}, main_player={Context.IsMainPlayer}, location={localPlayer.currentLocation?.NameOrUniqueName ?? "unknown"}.",
            LogLevel.Info);
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        if (!Context.IsWorldReady)
            return;

        this.DrainLocalPipeBridge();
        this.executions?.Update();
    }

    private void OnDayStarted(object? sender, DayStartedEventArgs e)
    {
        this.executions?.InvalidateForLifecycle("day_started");
        this.PublishLifecycle("connected", "day_started");
    }

    private void OnWarped(object? sender, WarpedEventArgs e)
    {
        if (Context.IsWorldReady && e.Player.UniqueMultiplayerID == Game1.player.UniqueMultiplayerID)
        {
            this.executions?.InvalidateForLifecycle("warped");
            this.PublishSemantic("snapshot_changed", "warped");
        }
    }

    private void OnSaving(object? sender, SavingEventArgs e)
    {
        this.executions?.InvalidateForLifecycle("saving");
        this.PublishLifecycle("world_unavailable", "saving");
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
    {
        this.executions?.InvalidateForLifecycle("returned_to_title");
        this.PublishLifecycle("world_unavailable", "returned_to_title");
        this.localPipeBridge?.Dispose();
        this.localPipeBridge = null;
        this.bridgeSession = null;
        this.executions = null;
        this.Monitor.Log("GameBuddy returned to title; local embodiment state cleared.", LogLevel.Trace);
    }

    private void StatusCommand(string command, string[] args)
    {
        if (!RequireWorld())
            return;

        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(this.executions!.CreateSnapshot(), BridgeProtocol.JsonOptions), LogLevel.Info);
    }

    private void MoveFixtureCommand(string command, string[] args)
    {
        if (!RequireWorld())
            return;

        if (args.Length != 3 || !float.TryParse(args[0], out float x) || !float.TryParse(args[1], out float y) || !IsOpaqueRequestId(args[2]))
        {
            this.Monitor.Log("Usage: gamebuddy_move_fixture <tile-x> <tile-y> <request-id>; request-id must be 1-64 letters, digits, _ or -.", LogLevel.Warn);
            return;
        }

        LocalExecutionReceipt receipt = this.executions!.RequestLocalMove(args[2], new Vector2(x, y));
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    private void EquipToolFixtureCommand(string command, string[] args)
    {
        if (!RequireWorld())
            return;

        if (args.Length != 2 || !int.TryParse(args[0], out int slot) || !IsOpaqueRequestId(args[1]))
        {
            this.Monitor.Log("Usage: gamebuddy_equip_tool_fixture <inventory-slot> <request-id>; request-id must be 1-64 letters, digits, _ or -.", LogLevel.Warn);
            return;
        }

        LocalExecutionReceipt receipt = this.executions!.RequestLocalEquipTool(args[1], slot);
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    private void ApproveMoveFixtureCommand(string command, string[] args)
    {
        if (!RequireWorld())
            return;
        if (args.Length != 2 || !float.TryParse(args[0], out float x) || !float.TryParse(args[1], out float y))
        {
            this.Monitor.Log("Usage: gamebuddy_approve_move_fixture <tile-x> <tile-y>.", LogLevel.Warn);
            return;
        }
        long generation = this.localPipeBridge?.CurrentGeneration ?? 0;
        string reasonCode = "bridge_unavailable";
        if (generation == 0 || this.bridgeSession is null || !this.bridgeSession.TryApproveMoveToTile(generation, x, y, out BridgeActionGrant? grant, out reasonCode) || grant is null)
        {
            this.Monitor.Log($"GameBuddy move approval refused: {reasonCode ?? "bridge_unavailable"}.", LogLevel.Warn);
            return;
        }
        if (!this.bridgeSession.TryCreateActionGrantEvent(generation, grant, out string json) || !this.localPipeBridge!.TryEnqueueOutbound(generation, json))
        {
            this.Monitor.Log("GameBuddy move approval was not delivered because the local bridge closed/backpressured.", LogLevel.Warn);
            return;
        }
        this.Monitor.Log($"GameBuddy approved one local bridge move target={x:0.##},{y:0.##}; grant expires in 30 seconds.", LogLevel.Info);
    }

    private void CancelCommand(string command, string[] args)
    {
        if (!RequireWorld())
            return;

        LocalExecutionReceipt receipt = this.executions!.CancelActiveForFixture("local_console_cancel");
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    private void DrainLocalPipeBridge()
    {
        if (this.localPipeBridge is null || this.bridgeSession is null)
            return;

        // Bound game-thread work; pipe I/O and framing are isolated in LocalPipeBridge.
        for (int index = 0; index < 8 && this.localPipeBridge.TryDequeueInbound(out PipeInbound inbound); index++)
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
                    "hello" => this.HandleHello(inbound.Generation, inbound.Json),
                    "observe_request" => this.HandleObserve(inbound.Generation, inbound.Json),
                    "execution_request" => this.HandleExecute(inbound.Generation, inbound.Json),
                    "cancel_request" => this.HandleCancel(inbound.Generation, inbound.Json),
                    _ => this.SerializeError(correlationId, "unknown_message_type"),
                };
                if (response is not null && !this.localPipeBridge.TryEnqueueOutbound(inbound.Generation, response))
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

    /** Receipt publication is game-thread-only and never performs pipe I/O. */
    private void PublishReceipt(LocalExecutionReceipt receipt)
    {
        if (this.localPipeBridge is null || this.bridgeSession is null)
            return;
        long generation = this.localPipeBridge.CurrentGeneration;
        if (generation != 0 && this.bridgeSession.TryCreateReceiptEvent(generation, receipt, out string json)
            && !this.localPipeBridge.TryEnqueueOutbound(generation, json))
            this.Monitor.Log("GameBuddy dropped receipt event due to closed/backpressured bridge.", LogLevel.Warn);
    }

    private void PublishSemantic(string kind, string reasonCode)
    {
        if (this.localPipeBridge is null || this.bridgeSession is null)
            return;
        long generation = this.localPipeBridge.CurrentGeneration;
        string correlationId = Guid.NewGuid().ToString("N");
        if (generation != 0 && this.bridgeSession.TryCreateSemanticEvent(generation, kind, correlationId, reasonCode, out string json)
            && !this.localPipeBridge.TryEnqueueOutbound(generation, json))
            this.Monitor.Log("GameBuddy dropped semantic event due to closed/backpressured bridge.", LogLevel.Warn);
    }

    private void PublishLifecycle(string state, string reasonCode)
    {
        if (this.localPipeBridge is null || this.bridgeSession is null)
            return;
        long generation = this.localPipeBridge.CurrentGeneration;
        string correlationId = Guid.NewGuid().ToString("N");
        if (generation != 0 && this.bridgeSession.TryCreateLifecycleEvent(generation, state, correlationId, reasonCode, out string json)
            && !this.localPipeBridge.TryEnqueueOutbound(generation, json))
            this.Monitor.Log("GameBuddy dropped lifecycle event due to closed/backpressured bridge.", LogLevel.Warn);
    }

    private string? SerializeError(string? correlationId, string reasonCode) => BridgeProtocol.TrySerialize(this.bridgeSession!.CreateError(correlationId, reasonCode), out string json, out _) ? json : null;

    private string? HandleHello(long generation, string json) => this.SerializeBridgeResponse<BridgeHello, BridgeHelloAck>(
        System.Text.Json.JsonSerializer.Deserialize<BridgeEnvelope<BridgeHello>>(json, BridgeProtocol.JsonOptions),
        (BridgeEnvelope<BridgeHello> request, out BridgeEnvelope<BridgeHelloAck>? response, out string reason) => this.bridgeSession!.TryAuthenticate(generation, request, out response, out reason), out _);

    private string? HandleObserve(long generation, string json) => this.SerializeBridgeResponse<BridgeObserveRequest, BridgeSnapshot>(
        System.Text.Json.JsonSerializer.Deserialize<BridgeEnvelope<BridgeObserveRequest>>(json, BridgeProtocol.JsonOptions),
        (BridgeEnvelope<BridgeObserveRequest> request, out BridgeEnvelope<BridgeSnapshot>? response, out string reason) => this.bridgeSession!.TryObserve(generation, request, out response, out reason), out _);

    private string? HandleExecute(long generation, string json) => this.SerializeBridgeResponse<BridgeExecutionRequest, BridgeReceipt>(
        System.Text.Json.JsonSerializer.Deserialize<BridgeEnvelope<BridgeExecutionRequest>>(json, BridgeProtocol.JsonOptions),
        (BridgeEnvelope<BridgeExecutionRequest> request, out BridgeEnvelope<BridgeReceipt>? response, out string reason) => this.bridgeSession!.TryExecute(generation, request, out response, out reason), out _);

    private string? HandleCancel(long generation, string json) => this.SerializeBridgeResponse<BridgeCancelRequest, BridgeReceipt>(
        System.Text.Json.JsonSerializer.Deserialize<BridgeEnvelope<BridgeCancelRequest>>(json, BridgeProtocol.JsonOptions),
        (BridgeEnvelope<BridgeCancelRequest> request, out BridgeEnvelope<BridgeReceipt>? response, out string reason) => this.bridgeSession!.TryCancel(generation, request, out response, out reason), out _);

    private string? SerializeBridgeResponse<TRequest, TResponse>(
        BridgeEnvelope<TRequest>? request,
        TryBridgeRequest<TRequest, TResponse> handler,
        out string reasonCode)
    {
        reasonCode = "invalid_envelope";
        if (request is null)
            return this.SerializeError(null, reasonCode);
        if (!handler(request, out BridgeEnvelope<TResponse>? response, out reasonCode) || response is null)
            return this.SerializeError(request.CorrelationId, reasonCode);
        return BridgeProtocol.TrySerialize(response, out string json, out _) ? json : this.SerializeError(request.CorrelationId, "response_serialization_failed");
    }

    private delegate bool TryBridgeRequest<TRequest, TResponse>(BridgeEnvelope<TRequest> request, out BridgeEnvelope<TResponse>? response, out string reasonCode);

    private bool RequireWorld()
    {
        if (!Context.IsWorldReady || this.executions is null)
        {
            this.Monitor.Log("Load a world before using GameBuddy embodiment diagnostics.", LogLevel.Warn);
            return false;
        }

        return true;
    }

    private static bool IsOpaqueRequestId(string value) => value.Length is >= 1 and <= 64 && value.All(character => (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');
}
