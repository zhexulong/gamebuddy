using System.Reflection;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewModdingAPI.Utilities;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// Embodiment entry point. State is isolated per local split-screen player.
/// The configured PlayerId selects the one real local Farmhand GameBuddy may
/// control; no state is created for the human player's screen.
/// </summary>
public sealed class ModEntry : Mod
{
    // Legacy split-screen fixture state. The formal AI client uses a single per-client state.
    private readonly PerScreen<ScreenEmbodimentState> screenStates = new(() => new ScreenEmbodimentState());
    private readonly ScreenEmbodimentState formalState = new();
    private ModConfig config = new();
    private HostFarmhandProvisioner? hostFarmhandProvisioner;
    private FarmhandProvisioner? farmhandProvisioner;
    private FarmhandProvisioningProbe? provisioningProbe;
    private bool embodimentInitialized;
    private bool hostRoleConfigured;
    private bool provisioningConfigurationRejected;
    private bool farmhandProvisioningTerminal;
    private bool hostAutomationStarted;
    private bool hostAutomationServerStarted;
    private bool hostAutomationTerminal;
    private long hostAutomationDeadlineUnixMs;
    private long nextFarmhandProvisionerAttemptAtMs;
    private bool hostAutomationSaveMenuOpened;
    private bool hostAutomationObservedAiClient;
    private bool hostAutomationObservedAiClientExit;

    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        helper.Events.GameLoop.GameLaunched += this.OnGameLaunched;
        helper.Events.GameLoop.SaveLoaded += this.OnSaveLoaded;
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.DayStarted += this.OnDayStarted;
        helper.Events.Player.Warped += this.OnWarped;
        helper.Events.GameLoop.Saving += this.OnSaving;
        helper.Events.GameLoop.Saved += this.OnSaved;
        helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;

        helper.ConsoleCommands.Add("gamebuddy_farmhands", "List authoritative local-co-op player and Farmhand identities without changing game state.", this.FarmhandsCommand);
        helper.ConsoleCommands.Add("gamebuddy_status", "Print the configured AI Farmhand's authoritative snapshot on its local screen.", this.StatusCommand);
        helper.ConsoleCommands.Add("gamebuddy_trace", "Print bounded AI Farmhand directive/route/body execution trace evidence.", this.TraceCommand);
        helper.ConsoleCommands.Add("gamebuddy_move_fixture", "Phase 1 local-only movement fixture: gamebuddy_move_fixture <tile-x> <tile-y> <request-id>.", this.MoveFixtureCommand);
        helper.ConsoleCommands.Add("gamebuddy_equip_tool_fixture", "Phase 1 local-only native mechanic fixture: gamebuddy_equip_tool_fixture <inventory-slot> <request-id>.", this.EquipToolFixtureCommand);
        helper.ConsoleCommands.Add("gamebuddy_cancel", "Cancel the active local AI Farmhand GameBuddy execution.", this.CancelCommand);

        this.Monitor.Log("GameBuddy Stardew Integration loaded; formal attachment requires a signed manifest and native Farmhand identity match.", LogLevel.Info);
    }

    private void OnGameLaunched(object? sender, GameLaunchedEventArgs e)
    {
        this.Monitor.Log($"GameBuddy health: SMAPI lifecycle hooks are available for Stardew {Game1.version} / multiplayer {StardewValley.Multiplayer.protocolVersion}.", LogLevel.Trace);
        bool hostConfigured = this.config.HostFarmhandProvisioning?.Enable == true;
        bool clientConfigured = this.config.FarmhandProvisioner?.Enable == true;
        this.hostRoleConfigured = hostConfigured;
        if (hostConfigured && clientConfigured)
        {
            this.provisioningConfigurationRejected = true;
            this.Monitor.Log("GameBuddy rejected Stardew provisioning configuration: host and AI-client roles cannot be enabled in one Mod profile.", LogLevel.Error);
            return;
        }
        if (hostConfigured)
        {
            this.hostFarmhandProvisioner = HostFarmhandProvisioner.TryStart(
                this.Helper,
                this.Monitor,
                this.config.HostFarmhandProvisioning,
                this.config.HostAutomation?.Enable == true);
            if (this.hostFarmhandProvisioner is null)
                this.Monitor.Log("GameBuddy host provisioning is enabled but its configuration is invalid; no client or diagnostic fallback was started.", LogLevel.Error);
            if (this.config.HostAutomation is { Enable: true } automation && !automation.IsValid)
            {
                this.hostAutomationTerminal = true;
                this.Monitor.Log("GameBuddy rejected the HostAutomation fixture configuration; no UI or fallback loader was started.", LogLevel.Error);
            }
            else if (this.config.HostAutomation?.Enable == true)
            {
                this.Monitor.Log($"GameBuddy HostAutomation fixture armed for native save '{this.config.HostAutomation.SaveName}'.", LogLevel.Info);
            }
            return;
        }
        if (clientConfigured)
        {
            if (this.config.FarmhandProvisioner is not { IsValid: true })
            {
                this.provisioningConfigurationRejected = true;
                this.Monitor.Log("GameBuddy rejected Stardew AI-client provisioning configuration; the formal client requires a valid controlled manifest path, token, and target version.", LogLevel.Error);
                return;
            }
            // Start while the native title/farmhand menu owns available-Farmhand
            // reception; the manifest itself binds the later world scope.
            this.TryStartFarmhandProvisioner();
            return;
        }
        this.provisioningProbe = FarmhandProvisioningProbe.TryStart(this.Monitor, this.config.FarmhandProvisioningProbe);
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
        // SaveGame.Load is driven by the native loader; start the diagnostic host
        // only after SMAPI confirms the world is fully available.
        this.TryStartHostAutomation();
        this.TryStartFarmhandProvisioner();
        this.TryInitializeEmbodiment();
    }

    private void TryStartFarmhandProvisioner()
    {
        if (this.provisioningConfigurationRejected || this.farmhandProvisioningTerminal || this.farmhandProvisioner is not null || this.config.FarmhandProvisioner?.Enable != true)
            return;
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now < this.nextFarmhandProvisionerAttemptAtMs)
            return;
        this.nextFarmhandProvisionerAttemptAtMs = now + 1_000;
        this.farmhandProvisioner = FarmhandProvisioner.TryStart(this.Monitor, this.config.FarmhandProvisioner);
    }

    private void TryInitializeEmbodiment()
    {
        if (this.embodimentInitialized || this.hostRoleConfigured || this.provisioningConfigurationRejected)
            return;
        bool formalClientConfigured = this.config.FarmhandProvisioner?.Enable == true;
        if (formalClientConfigured && (this.farmhandProvisioner is null || !this.farmhandProvisioner.IsReady))
            return;
        if (this.farmhandProvisioner is not null && !this.farmhandProvisioner.IsReady)
            return;
        ScreenEmbodimentState state = this.GetEmbodimentState();
        this.ClearState(state, "save_loaded");
        if (!this.IsConfiguredAiScreen(out Farmer? localPlayer, out string reason))
        {
            this.Monitor.Log($"GameBuddy ignored local screen {Context.ScreenId}: {reason}.", LogLevel.Trace);
            return;
        }

        state.Executions = new ExecutionManager(this.Monitor, receipt => this.PublishReceipt(state, receipt), this.config.EnabledActionSet);
        string saveId = formalClientConfigured
            ? this.farmhandProvisioner!.Manifest.SaveId
            : this.config.SaveId;
        string worldId = formalClientConfigured
            ? this.farmhandProvisioner!.Manifest.WorldId
            : this.config.WorldId;
        string playerId = formalClientConfigured
            ? this.farmhandProvisioner!.Manifest.FarmhandId
            : this.config.PlayerId;
        string companionId = formalClientConfigured
            ? this.farmhandProvisioner!.Manifest.CompanionId
            : this.config.CompanionId;
        bool saveScopeMatches = saveId == Game1.uniqueIDForThisGame.ToString();
        bool worldScopeMatches = worldId == Game1.MasterPlayer.UniqueMultiplayerID.ToString();
        bool playerScopeMatches = playerId == localPlayer!.UniqueMultiplayerID.ToString();
        bool scopeMatchesWorld = saveScopeMatches && worldScopeMatches && playerScopeMatches;
        bool bridgeConfigValid = this.config.EnableLocalBridge
            && BridgeProtocol.IsOpaqueId(this.config.PipeName)
            && this.config.BridgeToken.Length is >= 16 and <= 256
            && new BridgeScope("stardew", saveId, worldId, playerId, companionId).IsValid;
        state.BridgeSession = bridgeConfigValid && scopeMatchesWorld
            ? new BridgeSession(state.Executions, new BridgeScope("stardew", saveId, worldId, playerId, companionId), this.config.BridgeToken, this.config.EnabledActionSet)
            : null;
        state.LocalPipeBridge = state.BridgeSession is null ? null : new LocalPipeBridge(this.config.PipeName);
        if (!scopeMatchesWorld && formalClientConfigured)
            this.Monitor.Log("GameBuddy formal attachment remains closed: manifest and local save/world/Farmhand scope do not match.", LogLevel.Warn);
        if (this.config.EnableLocalBridge && state.BridgeSession is null)
            this.Monitor.Log(bridgeConfigValid
                ? "GameBuddy local bridge remains disabled: configured save/world scope does not bind to this AI Farmhand world."
                : "GameBuddy local bridge remains disabled: configuration must use opaque scope IDs and a 16+ character token.", LogLevel.Warn);
        else if (state.LocalPipeBridge is not null)
            this.Monitor.Log($"GameBuddy local named-pipe bridge started for AI Farmhand screen {Context.ScreenId}.", LogLevel.Info);

        this.embodimentInitialized = true;
        this.Monitor.Log(
            $"GameBuddy bound native AI Farmhand only: screen_id={Context.ScreenId}, farmhand_id={localPlayer!.UniqueMultiplayerID}, formal_attachment={this.farmhandProvisioner is not null}, location={localPlayer.currentLocation?.NameOrUniqueName ?? "unknown"}.",
            LogLevel.Info);
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        this.TryStartHostAutomation();
        this.TryStartFarmhandProvisioner();
        this.hostFarmhandProvisioner?.Update();
        this.TryObserveNativeAutomationClientExit();
        this.TryTriggerNativeAutomationSave();
        if (this.farmhandProvisioner is not null && this.farmhandProvisioner.Update())
        {
            if (!this.farmhandProvisioner.IsReady)
                this.farmhandProvisioningTerminal = true;
        }
        else if (this.provisioningProbe is not null && this.provisioningProbe.Update())
        {
            this.provisioningProbe = null;
        }

        this.TryInitializeEmbodiment();
        if (this.hostRoleConfigured || this.provisioningConfigurationRejected || this.hostFarmhandProvisioner is not null || !Context.IsWorldReady || !this.IsConfiguredAiScreen(out _, out _))
            return;

        ScreenEmbodimentState state = this.GetEmbodimentState();
        this.DrainLocalPipeBridge(state);
        state.Executions?.Update();
    }

    private void TryStartHostAutomation()
    {
        HostAutomationConfig? automation = this.config.HostAutomation;
        if (!this.hostRoleConfigured || automation?.Enable != true || this.hostAutomationTerminal)
            return;
        if (this.IsNativeAutomationWorldReady())
        {
            if (this.hostAutomationServerStarted)
                return;
            this.Monitor.Log($"GameBuddy HostAutomation observed native world ready: master={Game1.IsMasterGame}, server_present={Game1.server is not null}, multiplayer_mode={Game1.multiplayerMode}.", LogLevel.Info);
            if (!Game1.IsMasterGame)
            {
                this.hostAutomationTerminal = true;
                this.Monitor.Log("GameBuddy HostAutomation refused to start a LAN server because the loaded world is not the native master game.", LogLevel.Error);
                return;
            }
            try
            {
                if (Game1.server is null)
                {
                    Game1.options.enableServer = true;
                    Game1.multiplayerMode = 2;
                    if (!this.TryStartNativeLanServer())
                    {
                        this.hostAutomationTerminal = true;
                        this.Monitor.Log("GameBuddy HostAutomation could not resolve the target-version native LAN server entry point.", LogLevel.Error);
                        return;
                    }
                }
                this.hostAutomationServerStarted = Game1.server is not null;
                if (!this.hostAutomationServerStarted)
                {
                    this.hostAutomationTerminal = true;
                    this.Monitor.Log("GameBuddy HostAutomation could not start the native LAN server.", LogLevel.Error);
                    return;
                }
                this.Monitor.Log($"GameBuddy HostAutomation native world ready for save '{automation.SaveName}'; native LAN server started.", LogLevel.Info);
            }
            catch (Exception exception)
            {
                this.hostAutomationTerminal = true;
                this.Monitor.Log($"GameBuddy HostAutomation failed to start the native LAN server: {exception.GetType().Name}.", LogLevel.Error);
            }
            return;
        }
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.hostAutomationStarted)
        {
            if (now >= this.hostAutomationDeadlineUnixMs)
            {
                this.hostAutomationTerminal = true;
                this.Monitor.Log($"GameBuddy HostAutomation fixture timed out while loading native save '{automation.SaveName}'.", LogLevel.Error);
            }
            return;
        }

        this.hostAutomationStarted = true;
        this.hostAutomationDeadlineUnixMs = now + Math.Clamp(automation.TimeoutSeconds, 10, 300) * 1_000L;
        try
        {
            SaveGame.Load(automation.SaveName);
            // Match the native LoadGameMenu activation boundary. This clears
            // the title menu after SaveGame.Load without synthesizing input,
            // allowing the original game/SMAPI lifecycle to finish the load.
            Game1.exitActiveMenu();
            this.Monitor.Log($"GameBuddy HostAutomation requested native SaveGame.Load('{automation.SaveName}') and exited the native title menu; waiting for the original world/server lifecycle.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.hostAutomationTerminal = true;
            this.Monitor.Log($"GameBuddy HostAutomation failed to request native save load: {exception.GetType().Name}.", LogLevel.Error);
        }
    }

    private void TryObserveNativeAutomationClientExit()
    {
        if (!this.hostRoleConfigured || this.config.HostAutomation is not { Enable: true, TriggerNativeSaveAfterClientExit: true } || this.hostFarmhandProvisioner is null || !Context.IsWorldReady || !Game1.IsMasterGame)
            return;
        bool targetOnline;
        try
        {
            targetOnline = Game1.getOnlineFarmers().Any(farmer => farmer.UniqueMultiplayerID.ToString() == this.config.PlayerId);
        }
        catch
        {
            return;
        }
        if (targetOnline)
        {
            this.hostAutomationObservedAiClient = true;
            return;
        }
        if (this.hostAutomationObservedAiClient && !this.hostAutomationObservedAiClientExit && !this.hostFarmhandProvisioner.IsAwaitingSave)
            this.hostAutomationObservedAiClientExit = true;
    }

    private void TryTriggerNativeAutomationSave()
    {
        if (!this.hostRoleConfigured || this.config.HostAutomation is not { Enable: true } || this.hostFarmhandProvisioner is null)
        {
            // A completed request clears the latch so a later attachment in the
            // same host process gets its own native Saving/Saved cycle.
            this.hostAutomationSaveMenuOpened = false;
            return;
        }
        bool attachmentSavePending = this.config.HostAutomation.TriggerNativeSaveAfterAttachment && this.hostFarmhandProvisioner.IsAwaitingSave;
        bool clientExitSavePending = this.config.HostAutomation.TriggerNativeSaveAfterClientExit && this.hostAutomationObservedAiClientExit;
        if (!attachmentSavePending && !clientExitSavePending)
        {
            this.hostAutomationSaveMenuOpened = false;
            return;
        }
        if (this.hostAutomationSaveMenuOpened || !Context.IsWorldReady || !Game1.IsMasterGame || Game1.game1.IsSaving || Game1.activeClickableMenu is not null)
            return;
        this.hostAutomationSaveMenuOpened = true;
        if (clientExitSavePending)
        {
            this.hostAutomationObservedAiClient = false;
            this.hostAutomationObservedAiClientExit = false;
        }
        Game1.activeClickableMenu = new SaveGameMenu();
        this.Monitor.Log("GameBuddy HostAutomation opened the native SaveGameMenu to drive the original Saving/Saved lifecycle for the attachment fixture.", LogLevel.Info);
    }

    private bool IsNativeAutomationWorldReady() => Context.IsWorldReady
        || (this.config.HostAutomation?.Enable == true
            && Game1.hasLoadedGame
            && Game1.gameMode == Game1.playingGameMode
            && Game1.player is not null
            && Game1.locations is { Count: > 0 });

    private bool TryStartNativeLanServer()
    {
        try
        {
            FieldInfo? multiplayerField = typeof(Game1).GetField("multiplayer", BindingFlags.Static | BindingFlags.NonPublic);
            object? multiplayer = multiplayerField?.GetValue(null);
            MethodInfo? startServer = multiplayer?.GetType().GetMethod("StartServer", BindingFlags.Instance | BindingFlags.Public);
            if (multiplayer is null || startServer is null || startServer.GetParameters().Length != 0)
            {
                this.Monitor.Log($"GameBuddy HostAutomation native LAN adapter lookup failed: field={(multiplayer is not null)}, method={(startServer is not null)}.", LogLevel.Error);
                return false;
            }
            this.Monitor.Log("GameBuddy HostAutomation invoking the target-version native Multiplayer.StartServer().", LogLevel.Info);
            startServer.Invoke(multiplayer, Array.Empty<object>());
            this.Monitor.Log($"GameBuddy HostAutomation native Multiplayer.StartServer() returned: server_present={Game1.server is not null}.", LogLevel.Info);
            return Game1.server is not null;
        }
        catch (Exception exception)
        {
            this.Monitor.Log($"GameBuddy HostAutomation native LAN server adapter failed: {exception.GetType().Name}/{exception.InnerException?.GetType().Name ?? "none"}.", LogLevel.Error);
            return false;
        }
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
        this.hostFarmhandProvisioner?.OnSaving();
        if (!this.TryGetAiState(out ScreenEmbodimentState state))
            return;
        ExecutionManager executions = state.Executions!;
        executions.InvalidateForLifecycle("saving");
        this.PublishLifecycle(state, "world_unavailable", "saving");
    }

    private void OnSaved(object? sender, SavedEventArgs e)
    {
        this.hostFarmhandProvisioner?.OnSaved();
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
    {
        this.hostFarmhandProvisioner?.OnReturnedToTitle();
        this.hostAutomationSaveMenuOpened = false;
        this.farmhandProvisioner?.Disconnect();
        this.farmhandProvisioner = null;
        this.farmhandProvisioningTerminal = false;
        this.nextFarmhandProvisionerAttemptAtMs = 0;
        ScreenEmbodimentState state = this.GetEmbodimentState();
        this.embodimentInitialized = false;
        if (state.Executions is not null)
        {
            state.Executions.InvalidateForLifecycle("returned_to_title");
            this.PublishLifecycle(state, "world_unavailable", "returned_to_title");
        }
        this.ClearState(state, "returned_to_title");
        this.embodimentInitialized = false;
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
        if (this.hostFarmhandProvisioner is not null
            || (this.config.FarmhandProvisioner?.Enable == true && (this.farmhandProvisioner is null || !this.farmhandProvisioner.IsReady))
            || !Context.IsWorldReady
            || !this.IsConfiguredAiScreen(out _, out _))
            return false;
        ScreenEmbodimentState candidate = this.GetEmbodimentState();
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
        if (this.config.FarmhandProvisioner?.Enable == true && (this.farmhandProvisioner is null || !this.farmhandProvisioner.IsReady))
        {
            reasonCode = "formal_attachment_not_ready";
            return false;
        }
        localPlayer = Game1.player;
        string expectedPlayerId = this.config.FarmhandProvisioner?.Enable == true
            ? this.farmhandProvisioner!.Manifest.FarmhandId
            : this.config.PlayerId;
        if (expectedPlayerId != localPlayer.UniqueMultiplayerID.ToString())
        {
            reasonCode = this.farmhandProvisioner is null
                ? "screen_player_id_does_not_match_configured_ai_farmhand"
                : "screen_player_id_does_not_match_manifest_farmhand";
            return false;
        }
        reasonCode = "configured_ai_farmhand";
        return true;
    }

    private ScreenEmbodimentState GetEmbodimentState() => this.config.FarmhandProvisioner?.Enable == true ? this.formalState : this.screenStates.Value;

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
