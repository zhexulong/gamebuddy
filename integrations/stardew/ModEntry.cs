using System.Reflection;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Navigation;
using GameBuddy.Stardew.Handlers;
using HarmonyLib;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewModdingAPI.Utilities;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

/// <summary>
/// Embodiment entry point. State is isolated per local split-screen player.
/// The configured PlayerId selects the one real local Farmhand GameBuddy may
/// control; no state is created for the human player's screen.
/// </summary>
public sealed partial class ModEntry : Mod
{
    /// <summary>
    /// Launcher-injected per-launch generation for the formal AI Farmhand
    /// client role. Only valid for farmhand_client topology; absent or invalid
    /// for other roles. The value is an opaque 1-128 character string matching
    /// BridgeProtocol.IsOpaqueId. It is never read from config.json, operator
    /// config, or any persisted file.
    /// </summary>
    internal const string LaunchGenerationEnvironmentVariableName = "GAMEBUDDY_STARDEW_LAUNCH_GENERATION";

    /// <summary>
    /// Pure, stateless derivation of the bridge runtime attestation from
    /// the caller's topology booleans and a nullable environment variable.
    /// Returns null with a non-null reasonCode when the pair is invalid;
    /// returns the attestation and null reasonCode on success.
    /// The formal client role requires a valid opaque generation; native
    /// local fixture and unattested roles ignore the env value and always
    /// produce null generation. Contradictory booleans (both true) fail closed.
    /// </summary>
    internal static BridgeRuntimeAttestation? TryCreateRuntimeAttestation(
        bool formalClientConfigured,
        bool nativeLocalFixture,
        string? launchGenerationEnvironmentVariable,
        out string? reasonCode)
    {
        if (formalClientConfigured && nativeLocalFixture)
        {
            reasonCode = "contradictory_topology_booleans";
            return null;
        }

        if (formalClientConfigured)
        {
            if (string.IsNullOrEmpty(launchGenerationEnvironmentVariable) || !BridgeProtocol.IsOpaqueId(launchGenerationEnvironmentVariable))
            {
                reasonCode = "launch_generation_unavailable";
                return null;
            }
            reasonCode = null;
            return new BridgeRuntimeAttestation("farmhand_client", launchGenerationEnvironmentVariable);
        }

        if (nativeLocalFixture)
        {
            reasonCode = null;
            return new BridgeRuntimeAttestation("native_local_fixture", null);
        }

        reasonCode = null;
        return BridgeRuntimeAttestation.Default;
    }
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
    private bool hostAutomationFixtureInitialized;
    private bool hostAutomationFixtureReadinessPublished;
    private bool nativeLocalPlayerFixtureStarted;
    private bool nativeLocalPlayerFixtureInitialized;
    private bool nativeLocalPlayerFixtureTerminal;
    private long nativeLocalPlayerFixtureDeadlineUnixMs;
    private long nativeLocalPlayerFixtureLastReadinessLogUnixMs;
    private bool nativeLocalPlayerFixtureBootstrapInvoked;
    private bool nativeLocalPlayerFixtureBootstrapTerminal;
    private NativeLocalFeedFixturePending? nativeLocalFeedFixturePending;
    private NativeLocalCollectAnimalProductFixturePending? nativeLocalCollectAnimalProductFixturePending;
    private NativeLocalClearHoeDirtFixturePending? nativeLocalClearHoeDirtFixturePending;
    private NativeLocalDigArtifactSpotFixturePending? nativeLocalDigArtifactSpotFixturePending;
    private NativeLocalPlaceCrabPotFixturePending? nativeLocalPlaceCrabPotFixturePending;
    private NativeLocalBaitCrabPotFixturePending? nativeLocalBaitCrabPotFixturePending;
    private PortfolioLocalPlayerBinding? portfolioBinding;
    private PortfolioBridgeSession? portfolioBridgeSession;
    private PortfolioLocalPipeBridge? portfolioPipeBridge;
    private long portfolioBindingGeneration;
    private long portfolioLastObservedRevision = -1;
    private bool nativeChatObservationInstalled;
    private bool nativeChatStopCommandRegistered;
    private static ModEntry? nativeChatIngressOwner;

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
        helper.Events.Multiplayer.ModMessageReceived += this.OnModMessageReceived;

        helper.ConsoleCommands.Add("gamebuddy_farmhands", "List authoritative local-co-op player and Farmhand identities without changing game state.", this.FarmhandsCommand);
        helper.ConsoleCommands.Add("gamebuddy_status", "Print the configured AI Farmhand's authoritative snapshot on its local screen.", this.StatusCommand);
        helper.ConsoleCommands.Add("gamebuddy_trace", "Print bounded AI Farmhand directive/route/body execution trace evidence.", this.TraceCommand);
        // Fixture console mechanics are registered only under an explicit valid
        // NativeLocalPlayerFixture admission. Handlers additionally revalidate
        // the same admission on the game thread before executing, so a stale or
        // forged registration can never run outside the fixture.
        if (this.config.NativeLocalPlayerFixture is { IsValid: true })
        {
            helper.ConsoleCommands.Add("gamebuddy_move_fixture", "Phase 1 local-only movement fixture: gamebuddy_move_fixture <tile-x> <tile-y> <request-id>.", this.MoveFixtureCommand);
            helper.ConsoleCommands.Add("gamebuddy_equip_tool_fixture", "Phase 1 local-only native mechanic fixture: gamebuddy_equip_tool_fixture <inventory-slot> <request-id>.", this.EquipToolFixtureCommand);
            helper.ConsoleCommands.Add("gamebuddy_cancel", "Cancel the active local AI Farmhand GameBuddy execution.", this.CancelCommand);
        }

        this.Monitor.Log("GameBuddy Stardew Integration loaded; formal attachment requires a signed manifest and native Farmhand identity match.", LogLevel.Info);
    }

    private void InstallNativeChatIngress()
    {
        if (this.config.HostFarmhandProvisioning is not { IsValid: true } host
            || !NativeChatIngressPolicy.CanInstallForHostRole(this.hostRoleConfigured, this.hostFarmhandProvisioner is not null)
            || !NativeChatIngressPolicy.IsSupportedRuntime(
                Game1.version,
                Game1.versionBuildNumber,
                Constants.ApiVersion.ToString()))
        {
            this.nativeChatObservationInstalled = false;
            this.nativeChatStopCommandRegistered = false;
            nativeChatIngressOwner = null;
            this.Monitor.Log("GameBuddy disabled native chat ingress: target_game_or_smapi_version_mismatch.", LogLevel.Error);
            return;
        }
        MethodInfo? textSubmitTarget;
        MethodInfo? textSubmitPostfix;
        MethodInfo? textBoxDelegateTarget;
        MethodInfo? textBoxDelegatePostfix;
        try
        {
            textSubmitTarget = AccessTools.Method(typeof(ChatBox), "textBoxEnter", new[] { typeof(string) });
            textSubmitPostfix = AccessTools.Method(typeof(ModEntry), nameof(NativeChatTextBoxEnterPostfix));
            textBoxDelegateTarget = AccessTools.Method(typeof(ChatBox), "textBoxEnter", new[] { typeof(TextBox) });
            textBoxDelegatePostfix = AccessTools.Method(typeof(ModEntry), nameof(NativeChatTextBoxEnterDelegatePrefix));
            if (textSubmitTarget is null || textSubmitPostfix is null || textBoxDelegateTarget is null || textBoxDelegatePostfix is null
                || !NativeChatIngressPolicy.IsTextSubmitPostfix(
                    textSubmitTarget.DeclaringType?.FullName,
                    textSubmitTarget.Name,
                    textSubmitTarget.GetParameters().Select(parameter => parameter.ParameterType).ToArray(),
                    textSubmitTarget.GetParameters().Select(parameter => parameter.Name).ToArray(),
                    isPostfix: true)
                || !NativeChatIngressPolicy.IsTextBoxDelegatePrefix(
                    textBoxDelegateTarget.DeclaringType?.FullName,
                    textBoxDelegateTarget.Name,
                    textBoxDelegateTarget.GetParameters().Select(parameter => parameter.ParameterType).ToArray(),
                    textBoxDelegateTarget.GetParameters().Select(parameter => parameter.Name).ToArray(),
                    isPrefix: true))
                throw new MissingMethodException("ChatBox.textBoxEnter(string/TextBox)");
        }
        catch (Exception exception)
        {
            this.nativeChatObservationInstalled = false;
            this.nativeChatStopCommandRegistered = false;
            nativeChatIngressOwner = null;
            this.Monitor.Log($"GameBuddy disabled native chat text observation: lookup_failed ({exception.GetType().Name}).", LogLevel.Error);
            return;
        }
        try
        {
            Harmony harmony = new(this.ModManifest.UniqueID + ".native-chat-ingress");
            harmony.Patch(textSubmitTarget, postfix: new HarmonyMethod(textSubmitPostfix));
            harmony.Patch(textBoxDelegateTarget, prefix: new HarmonyMethod(textBoxDelegatePostfix));
            nativeChatIngressOwner = this;
            this.nativeChatObservationInstalled = true;
            this.Monitor.Log("GameBuddy enabled native chat text observation.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.nativeChatObservationInstalled = false;
            this.nativeChatStopCommandRegistered = false;
            nativeChatIngressOwner = null;
            this.Monitor.Log($"GameBuddy disabled native chat text observation: patch_failed ({exception.GetType().Name}).", LogLevel.Error);
            return;
        }
        if (ChatCommands.Exists("stop"))
        {
            this.nativeChatStopCommandRegistered = false;
            this.Monitor.Log("GameBuddy disabled native /stop: command_registration_conflict (CommandNameConflict).", LogLevel.Error);
            return;
        }
        try
        {
            ChatCommands.Register("stop", this.StopChatCommand, _ => "Stop the bound GameBuddy Farmhand.", multiplayerOnly: true);
            this.nativeChatStopCommandRegistered = true;
            this.Monitor.Log("GameBuddy enabled native /stop control.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.nativeChatStopCommandRegistered = false;
            this.Monitor.Log($"GameBuddy disabled native /stop: command_registration_failed ({exception.GetType().Name}).", LogLevel.Error);
        }
    }

    private void OnGameLaunched(object? sender, GameLaunchedEventArgs e)
    {
        this.Monitor.Log($"GameBuddy health: SMAPI lifecycle hooks are available for Stardew {Game1.version} / multiplayer {StardewValley.Multiplayer.protocolVersion}.", LogLevel.Trace);
        if (!this.config.HasValidActionPolicy)
        {
            this.provisioningConfigurationRejected = true;
            this.Monitor.Log("GameBuddy rejected Stardew Game Action policy: use ActionPolicyVersion 1 with known DeniedActions/DeniedActionFamilies, or an explicit legacy EnabledActions configuration.", LogLevel.Error);
            return;
        }
        if (this.config.Portfolio?.P0bLifecycleProducer?.Enable == true && !this.config.IsP0bExclusiveConfigurationValid)
        {
            this.provisioningConfigurationRejected = true;
            this.Monitor.Log("GameBuddy rejected Portfolio P0b configuration: P0b requires every fixture, bootstrap, automation, and provisioning mode to be explicitly disabled, including root ModConfig modes.", LogLevel.Error);
            return;
        }
        if (this.config.Portfolio?.Enable == true)
        {
            if (this.config.NativeLocalPlayerFixture?.Enable == true)
            {
                this.provisioningConfigurationRejected = true;
                this.Monitor.Log("GameBuddy rejected configuration: NativeLocalPlayerFixture and Portfolio cannot be enabled together.", LogLevel.Error);
                return;
            }
            this.hostRoleConfigured = false;
            this.provisioningProbe = null;
            if (this.config.Portfolio.Bootstrap is { Enable: true })
            {
                this.Monitor.Log(this.config.Portfolio.IsBootstrapValid
                    ? "GameBuddy Portfolio native-save bootstrap armed: only the target-version title-screen new-game lifecycle may run; observe bridge remains closed until bootstrap disarms itself."
                    : "GameBuddy rejected Portfolio native-save bootstrap configuration; no save or bridge was started.",
                    this.config.Portfolio.IsBootstrapValid ? LogLevel.Info : LogLevel.Error);
            }
            else
            {
                this.Monitor.Log(this.config.Portfolio.IsValid
                    ? "GameBuddy Portfolio topology enabled: Farmhand/provisioning/HostAutomation surfaces are disabled; observe-only native local Player binding will begin after SaveLoaded."
                    : "GameBuddy rejected Portfolio configuration; no Farmhand or Portfolio bridge was started.",
                    this.config.Portfolio.IsValid ? LogLevel.Info : LogLevel.Error);
            }
            return;
        }
        if (this.config.NativeLocalPlayerFixture?.Enable == true)
        {
            if ((!this.config.NativeLocalPlayerFixture.IsValid && !this.config.NativeLocalPlayerFixture.IsBootstrapValid)
                || this.config.HostFarmhandProvisioning?.Enable == true
                || this.config.FarmhandProvisioner?.Enable == true
                || this.config.HostAutomation?.Enable == true)
            {
                this.provisioningConfigurationRejected = true;
                this.Monitor.Log("GameBuddy rejected NativeLocalPlayerFixture configuration: it requires a GameBuddyFixture save and no HostAutomation, Farmhand provisioning, LAN host, or Portfolio topology.", LogLevel.Error);
                return;
            }
            this.hostRoleConfigured = false;
            this.Monitor.Log(this.config.NativeLocalPlayerFixture.Bootstrap is { Enable: true }
                ? "GameBuddy native-local-player fixture bootstrap armed: target-version new-game creation will run at title screen and bridge remains closed until native SaveLoaded records its slot/scope."
                : "GameBuddy native-local-player fixture armed for its explicit observed native save slot.", LogLevel.Info);
            return;
        }
        bool hostConfigured = this.config.HostFarmhandProvisioning?.Enable == true;
        bool clientConfigured = this.config.FarmhandProvisioner?.Enable == true;
        if (hostConfigured)
        {
            string? launchGeneration = Environment.GetEnvironmentVariable(LaunchGenerationEnvironmentVariableName);
            if (launchGeneration is null || !BridgeProtocol.IsOpaqueId(launchGeneration))
            {
                this.provisioningConfigurationRejected = true;
                this.Monitor.Log("GameBuddy rejected Player Host provisioning: launcher launch generation is missing or invalid; no Host or fallback topology was started.", LogLevel.Error);
                return;
            }
            this.config.HostFarmhandProvisioning!.LaunchGeneration = launchGeneration;
        }
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
            else
                this.InstallNativeChatIngress();
            if (this.config.HostAutomation is { Enable: true } automation && !automation.IsValid)
            {
                this.hostAutomationTerminal = true;
                this.PublishFixtureReadiness(automation, "fixture_blocked", "fixture_configuration_invalid");
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

    private void StopChatCommand(string[] command, ChatBox chat)
    {
        if (!NativeChatIngressPolicy.CanPublishStopAll(this.nativeChatObservationInstalled, this.nativeChatStopCommandRegistered))
        {
            chat.addErrorMessage("GameBuddy player control is unavailable.");
            return;
        }
        if (!NativeChatIngressPolicy.IsBareStopCommand(command))
        {
            chat.addErrorMessage("Usage: /stop");
            return;
        }
        this.PublishNativeChat(PlayerControlProtocol.StopAll, null, chat);
    }

    // Harmony binds ordinary postfix parameters by the target's parameter
    // name. Preserve the pinned ChatBox.textBoxEnter(string text_to_send)
    // name rather than relying on positional binding.
    private static void NativeChatTextBoxEnterPostfix(string text_to_send)
    {
        try { nativeChatIngressOwner?.ObserveNativeChatText(text_to_send); }
        catch
        {
            // Never interrupt native chat. This fixed redacted stage marker is
            // the sole visibility of an otherwise contained observer failure.
            nativeChatIngressOwner?.MonitorNativeChatIngress("postfix_exception");
        }
    }

    // This prefix follows the target's actual TextBoxEvent delegate before its
    // implementation clears the ChatTextBox. It must never inspect sender or
    // provide another way to obtain submitted text.
    private static void NativeChatTextBoxEnterDelegatePrefix(TextBox sender)
    {
        try { nativeChatIngressOwner?.MonitorNativeChatIngress("textbox_delegate_prefix_reached"); }
        catch
        {
            nativeChatIngressOwner?.MonitorNativeChatIngress("delegate_prefix_exception");
        }
    }

    private void ObserveNativeChatText(string text)
    {
        NativeChatIngressTextClassification classification = NativeChatIngressPolicy.ClassifySubmittedText(text);
        this.MonitorNativeChatIngress($"postfix_reached_{classification}");
        if (!NativeChatIngressPolicy.CanPublishPlayerInput(this.nativeChatObservationInstalled))
        {
            this.MonitorNativeChatIngress("player_input_observer_unavailable");
            return;
        }
        if (classification != NativeChatIngressTextClassification.Ordinary)
            return;
        this.PublishNativeChat(PlayerControlProtocol.PlayerInput, text, null);
    }

    /// <summary>
    /// Bounded diagnostics for one native-chat ingress run. It deliberately
    /// accepts a fixed stage vocabulary only: never text, IDs, scope, locale,
    /// token, message body, or exception data.
    /// </summary>
    private void MonitorNativeChatIngress(string stage) =>
        // These fixed redacted stages are the live diagnosis boundary. Debug is
        // retained in the default SMAPI log; Trace is not, which made the
        // previous no-reply run observationally inconclusive.
        this.Monitor.Log($"GameBuddy native chat ingress stage={stage}.", LogLevel.Debug);

    private void PublishNativeChat(string kind, string? text, ChatBox? chat)
    {
        if (kind == PlayerControlProtocol.PlayerInput && (string.IsNullOrWhiteSpace(text) || text.Length > PlayerControlProtocol.MaximumTextLength))
        {
            this.MonitorNativeChatIngress("player_input_invalid_after_classification");
            return;
        }
        if (!Context.IsWorldReady || Game1.player is null || !Game1.IsMasterGame || this.hostFarmhandProvisioner is null)
        {
            this.MonitorNativeChatIngress("dispatch_world_or_host_unavailable");
            chat?.addErrorMessage("GameBuddy player control is unavailable in this world.");
            return;
        }
        FarmhandBindingStore bindings;
        try { bindings = this.Helper.Data.ReadSaveData<FarmhandBindingStore>(FarmhandProvisioningProtocol.SaveDataKey) ?? new FarmhandBindingStore(); }
        catch
        {
            this.MonitorNativeChatIngress("dispatch_binding_store_unavailable");
            chat?.addErrorMessage("GameBuddy player control binding is unavailable.");
            return;
        }
        string saveId = Game1.uniqueIDForThisGame.ToString();
        string worldId = Game1.MasterPlayer.UniqueMultiplayerID.ToString();
        FarmhandBinding[] matches = bindings.Bindings.Where(binding => binding.SaveId == saveId && binding.WorldId == worldId).ToArray();
        if (matches.Length != 1 || !long.TryParse(matches[0].FarmhandId.ToString(), out long farmhandId))
        {
            this.MonitorNativeChatIngress("dispatch_bound_farmhand_unavailable");
            chat?.addErrorMessage("GameBuddy has no uniquely bound connected Farmhand.");
            return;
        }
        IMultiplayerPeer? peer = this.Helper.Multiplayer.GetConnectedPlayer(farmhandId);
        if (!NativeChatIngressPolicy.CanRoutePlayerControlToBoundFarmhand(
            peer is not null,
            peer?.HasSmapi == true,
            peer?.HasSmapi == true ? peer.Mods.Select(mod => mod.ID) : null,
            this.ModManifest.UniqueID))
        {
            // SendMessage silently filters out vanilla or non-target-mod peers;
            // declare that fixed condition rather than recording an attempt that
            // no remote Farmhand can receive.
            this.MonitorNativeChatIngress("dispatch_bound_farmhand_modmessage_unavailable");
            chat?.addErrorMessage("GameBuddy has no ModMessage-capable bound Farmhand.");
            return;
        }
        BridgeScope scope = new("stardew", saveId, worldId, farmhandId.ToString(), matches[0].CompanionId);
        if (!scope.IsValid)
        {
            this.MonitorNativeChatIngress("dispatch_scope_invalid");
            chat?.addErrorMessage("GameBuddy player control scope is unavailable.");
            return;
        }
        string locale = NativeChatPresentationPolicy.CurrentBcp47Locale();
        if (!NativeChatPresentationPolicy.IsValidBcp47Locale(locale))
        {
            this.MonitorNativeChatIngress("dispatch_locale_invalid");
            chat?.addErrorMessage("GameBuddy player control locale is unavailable.");
            return;
        }
        PlayerControlModMessage message = new(Guid.NewGuid().ToString("N"), Game1.player.UniqueMultiplayerID.ToString(), scope, kind,
            Guid.NewGuid().ToString("N"), Guid.NewGuid().ToString("N"), text, locale);
        this.Helper.Multiplayer.SendMessage(message, PlayerControlProtocol.MessageType, new[] { this.ModManifest.UniqueID }, new[] { farmhandId });
        this.MonitorNativeChatIngress("dispatch_modmessage_send_attempted");
    }

    private void OnModMessageReceived(object? sender, ModMessageReceivedEventArgs e)
    {
        if (e.FromModID != this.ModManifest.UniqueID || e.Type != PlayerControlProtocol.MessageType)
            return;
        // Record wire arrival before role/lifecycle admission so an early guard
        // cannot masquerade as a failed host-to-AI transport.
        this.MonitorNativeChatIngress("ai_modmessage_wire_received");
        if (!Context.IsWorldReady || !this.IsConfiguredAiScreen(out Farmer? localPlayer, out _))
        {
            this.MonitorNativeChatIngress("ai_modmessage_receiver_unavailable");
            return;
        }
        this.MonitorNativeChatIngress("ai_modmessage_received");
        PlayerControlModMessage message;
        try { message = e.ReadAs<PlayerControlModMessage>(); }
        catch
        {
            this.MonitorNativeChatIngress("ai_modmessage_malformed");
            this.Monitor.Log("GameBuddy rejected malformed player-control ModMessage.", LogLevel.Warn);
            return;
        }
        ScreenEmbodimentState state = this.GetEmbodimentState();
        PlayerControlReplayGuard? replayGuard = state.PlayerControlReplayGuard;
        if (!PlayerControlProtocol.IsValid(message, out string reasonCode)
            || e.FromPlayerID.ToString() != message.IssuerPlayerId
            || message.IssuerPlayerId != Game1.MasterPlayer.UniqueMultiplayerID.ToString()
            || message.Scope.IntegrationId != "stardew"
            || message.Scope.SaveId != Game1.uniqueIDForThisGame.ToString()
            || message.Scope.WorldId != Game1.MasterPlayer.UniqueMultiplayerID.ToString()
            || message.Scope.PlayerId != localPlayer!.UniqueMultiplayerID.ToString()
            || message.Scope.CompanionId != (this.config.FarmhandProvisioner?.Enable == true ? this.farmhandProvisioner?.Manifest.CompanionId : this.config.CompanionId)
            || replayGuard is null
            || !replayGuard.TryConsume(message.MessageId))
        {
            this.MonitorNativeChatIngress("ai_modmessage_rejected");
            this.Monitor.Log($"GameBuddy rejected player-control ModMessage: {reasonCode}.", LogLevel.Warn);
            return;
        }
        long generation = state.LocalPipeBridge?.CurrentGeneration ?? 0;
        BridgePlayerControlFact fact = new(message.Kind, message.ControlId, message.SourceEventId, message.Text, message.Locale, message.IssuerPlayerId);
        if (state.BridgeSession is null || generation == 0 || !state.BridgeSession.TryCreatePlayerControlEvent(generation, fact, message.MessageId, out string json))
        {
            this.MonitorNativeChatIngress("ai_bridge_unavailable");
            this.Monitor.Log("GameBuddy rejected player-control ModMessage because the authenticated bridge is unavailable.", LogLevel.Warn);
            return;
        }
        if (!state.LocalPipeBridge!.TryEnqueueOutbound(generation, json, out PipeOutboundCompletion completion))
        {
            // The frame never entered the authenticated bridge queue, so it
            // cannot have reached Host. Release only this exact reservation.
            state.BridgeSession.TryAbandonPlayerControl(generation, message.ControlId, message.SourceEventId);
            this.MonitorNativeChatIngress("ai_bridge_unavailable");
            this.Monitor.Log("GameBuddy rejected player-control ModMessage because the authenticated bridge is unavailable.", LogLevel.Warn);
            return;
        }
        this.MonitorNativeChatIngress("ai_player_control_pipe_enqueued");
        this.TrackNativeChatPipeDelivery(state, generation, completion);
        if (message.Kind == PlayerControlProtocol.StopAll)
        {
            // STOP is the Mod-side presentation authority: it invalidates any
            // request already queued on the pipe before that request is drained.
            state.BridgeSession.AdvancePresentationEpoch();
            state.StopObservationEpoch++;
            state.PendingStopObservation = new BridgeStopObservation("body_settled", message.ControlId, message.SourceEventId, state.StopObservationEpoch);
        }
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
        // Configuration rejection is terminal for this load. Do not allow an
        // invalid P0b-exclusive profile to reach any Portfolio lifecycle owner.
        if (this.provisioningConfigurationRejected)
            return;
        // Portfolio is a single-player native topology. It must not enter the
        // Farmhand fixture, host automation, provisioning, or embodiment paths.
        if (this.config.Portfolio?.Enable == true)
        {
            if (this.config.Portfolio.Bootstrap is { Enable: true })
            {
                if (this.TryCompletePortfolioBootstrap())
                    return;
                this.TryInitializePortfolioBinding();
                return;
            }
            if (this.config.Portfolio.InitialNativeLoad is { Enable: true })
            {
                // A rejected native load is terminal and must never fall through
                // into binding initialization. Only a successfully observed
                // current slot/scope is allowed to open the Portfolio bridge.
                if (this.TryCompletePortfolioInitialNativeLoad() == PortfolioInitialNativeLoadCompletion.Succeeded)
                    this.TryInitializePortfolioBinding();
                return;
            }
            this.TryInitializePortfolioBinding();
            this.OnPortfolioP0bSaveLoaded();
            return;
        }
        if (this.config.NativeLocalPlayerFixture?.Enable == true)
        {
            if (this.config.NativeLocalPlayerFixture.Bootstrap is { Enable: true })
            {
                this.TryCompleteNativeLocalPlayerFixtureBootstrap();
                return;
            }
            this.TryInitializeNativeLocalPlayerFixture();
            return;
        }
        // Fixture setup, when explicitly armed, runs on the Host game thread
        // before a LAN server/attachment exists. It never calls production actions.
        this.TryInitializeNativeFixtureScenario();
        // Start the diagnostic host only after SMAPI confirms the world is fully available.
        this.TryStartHostAutomation();
        this.TryStartFarmhandProvisioner();
        this.TryInitializeEmbodiment();
    }

    private void TryInitializeNativeLocalPlayerFixture()
    {
        NativeLocalPlayerFixtureConfig? fixture = this.config.NativeLocalPlayerFixture;
        if (fixture is not { Enable: true } || this.nativeLocalPlayerFixtureTerminal)
            return;
        if (fixture.Bootstrap is { Enable: true })
        {
            this.TryBootstrapNativeLocalPlayerFixture(fixture);
            return;
        }

        if (Context.IsWorldReady)
        {
            // This asserts the current live actor/process, not historical
            // Farmer records retained in a disposable fixture save. A cloned
            // prior Farmhand fixture can still contain offline records; those
            // must neither start nor authorize another actor here.
            if (Context.IsMultiplayer || Game1.getAllFarmers().Count() != 1 || !Game1.IsMasterGame || Game1.server is not null || Game1.player is not Farmer localPlayer || localPlayer.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID)
            {
                this.nativeLocalPlayerFixtureTerminal = true;
                this.Monitor.Log("GameBuddy native-local-player fixture refused the loaded world because the current process is not the sole native master local Player without a LAN server.", LogLevel.Error);
                return;
            }
            this.TryInitializeNativeLocalPlayerFixtureScenario(fixture);
            // The shared embodiment initializes only after the native load
            // lifecycle has made Game1.player available. Any scenario setup is
            // bounded, happens before attachment, and never produces a receipt.
            return;
        }

        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.nativeLocalPlayerFixtureStarted)
        {
            if (now >= this.nativeLocalPlayerFixtureDeadlineUnixMs)
            {
                this.nativeLocalPlayerFixtureTerminal = true;
                this.Monitor.Log("GameBuddy native-local-player fixture timed out loading its explicit observed native save slot.", LogLevel.Error);
            }
            return;
        }

        this.nativeLocalPlayerFixtureStarted = true;
        this.nativeLocalPlayerFixtureDeadlineUnixMs = now + fixture.TimeoutSeconds * 1_000L;
        try
        {
            SaveGame.Load(fixture.ObservedSaveSlot);
            Game1.exitActiveMenu();
            this.Monitor.Log($"GameBuddy native-local-player fixture requested native SaveGame.Load for its explicit observed slot and is waiting for SaveLoaded.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log($"GameBuddy native-local-player fixture failed to request native save load: {exception.GetType().Name}.", LogLevel.Error);
        }
    }

    private void TryBootstrapNativeLocalPlayerFixture(NativeLocalPlayerFixtureConfig fixture)
    {
        NativeLocalPlayerFixtureBootstrapConfig? bootstrap = fixture.Bootstrap;
        if (bootstrap is not { Enable: true } || this.nativeLocalPlayerFixtureBootstrapTerminal)
            return;
        if (!fixture.IsBootstrapValid)
        {
            this.nativeLocalPlayerFixtureBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected native-local-player fixture bootstrap configuration.", LogLevel.Error);
            return;
        }
        // createdNewCharacter() switches into native loading before SMAPI
        // raises SaveLoaded. Do not mistake that expected intermediate world
        // state for a second bootstrap attempt.
        if (this.nativeLocalPlayerFixtureBootstrapInvoked)
            return;
        if (Context.IsWorldReady || Game1.hasLoadedGame)
        {
            this.nativeLocalPlayerFixtureBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected native-local-player fixture bootstrap because a world was already loaded before native creation began.", LogLevel.Error);
            return;
        }
        if (Game1.activeClickableMenu is not StardewValley.Menus.TitleMenu titleMenu)
            return;
        if (SaveGame.IsNewGameSaveNameCollision(bootstrap.SaveName))
        {
            this.nativeLocalPlayerFixtureBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected native-local-player fixture bootstrap because the requested native save name already exists.", LogLevel.Error);
            return;
        }
        try
        {
            Game1.resetPlayer();
            Game1.SetSaveName(bootstrap.SaveName);
            Game1.player.Name = bootstrap.PlayerName;
            Game1.player.farmName.Value = bootstrap.SaveName;
            Game1.player.favoriteThing.Value = "GameBuddyFixture";
            if (!string.Equals(Game1.GetSaveGameName(set_value: false), bootstrap.SaveName, StringComparison.Ordinal))
                throw new InvalidOperationException("fixture_native_save_name_resolution_failed");
            this.nativeLocalPlayerFixtureBootstrapInvoked = true;
            titleMenu.createdNewCharacter(skipIntro: true);
            this.Monitor.Log("GameBuddy requested target-version native local fixture creation; waiting for native SaveLoaded.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.nativeLocalPlayerFixtureBootstrapTerminal = true;
            this.Monitor.Log($"GameBuddy native-local-player fixture bootstrap failed: {exception.GetType().Name}.", LogLevel.Error);
        }
    }

    private void TryCompleteNativeLocalPlayerFixtureBootstrap()
    {
        NativeLocalPlayerFixtureConfig? fixture = this.config.NativeLocalPlayerFixture;
        NativeLocalPlayerFixtureBootstrapConfig? bootstrap = fixture?.Bootstrap;
        if (fixture is null || bootstrap is not { Enable: true })
            return;
        if (!fixture.IsBootstrapValid || !Context.IsWorldReady || !Game1.hasLoadedGame || Game1.player is null || Context.IsMultiplayer || !Game1.IsMasterGame)
        {
            this.nativeLocalPlayerFixtureBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected native-local-player fixture bootstrap completion because the native world is not single-player local-player.", LogLevel.Error);
            return;
        }
        string logicalName = Game1.GetSaveGameName(set_value: false);
        string requestedFilteredName = new string(bootstrap.SaveName.Where(char.IsLetterOrDigit).ToArray());
        string observedSlot = $"{requestedFilteredName}_{Game1.uniqueIDForThisGame}";
        // Target-version new-game completion can report the physical basename
        // from GetSaveGameName(), while the requested logical identity is the
        // name filtered by SaveGame.FilterFileName. Bind with the observed
        // native unique ID rather than treating the slot suffix as a failure.
        if (!string.Equals(new string(logicalName.Where(char.IsLetterOrDigit).ToArray()), requestedFilteredName, StringComparison.Ordinal)
            || !observedSlot.StartsWith("GameBuddyFixture", StringComparison.Ordinal))
        {
            this.nativeLocalPlayerFixtureBootstrapTerminal = true;
            this.Monitor.Log("GameBuddy rejected native-local-player fixture bootstrap completion because observed native save identity differs from the requested isolated fixture name.", LogLevel.Error);
            return;
        }
        NativeLocalPlayerFixtureConfig completedFixture = new()
        {
            Enable = true,
            LogicalSaveName = requestedFilteredName,
            ObservedSaveSlot = observedSlot,
            TimeoutSeconds = fixture.TimeoutSeconds,
            FixtureScenario = fixture.FixtureScenario,
            Bootstrap = new NativeLocalPlayerFixtureBootstrapConfig { Enable = false, SaveName = requestedFilteredName, PlayerName = bootstrap.PlayerName },
        };
        this.config = new ModConfig
        {
            EnableLocalBridge = this.config.EnableLocalBridge,
            PipeName = this.config.PipeName,
            BridgeToken = this.config.BridgeToken,
            SaveId = Game1.uniqueIDForThisGame.ToString(),
            WorldId = Game1.MasterPlayer.UniqueMultiplayerID.ToString(),
            PlayerId = Game1.player.UniqueMultiplayerID.ToString(),
            CompanionId = this.config.CompanionId,
            NativeLocalPlayerFixture = completedFixture,
            ActionPolicyVersion = 0,
            DeniedActions = new List<string>(),
            DeniedActionFamilies = new List<string>(),
            ExperimentalActions = new List<string>(),
            EnabledActions = this.config.EnabledActions,
        };
        this.Helper.WriteConfig(this.config);
        this.nativeLocalPlayerFixtureBootstrapTerminal = true;
        this.Monitor.Log("GameBuddy recorded target-version native local fixture scope and disarmed fixture bootstrap before opening bridge.", LogLevel.Info);
    }

    private void TryInitializeNativeLocalPlayerFixtureScenario(NativeLocalPlayerFixtureConfig fixture)
    {
        if (this.nativeLocalPlayerFixtureInitialized || this.nativeLocalPlayerFixtureTerminal)
            return;
        // A fixture warp completes through the native lifecycle and its
        // OnWarped handler finalizes the spatial precondition. Do not rerun
        // any scenario setup while any pre-attachment transition is live.
        if (this.nativeLocalFeedFixturePending is not null
            || this.nativeLocalCollectAnimalProductFixturePending is not null
            || this.nativeLocalClearHoeDirtFixturePending is not null
            || this.nativeLocalDigArtifactSpotFixturePending is not null
            || this.nativeLocalPlaceCrabPotFixturePending is not null
            || this.nativeLocalBaitCrabPotFixturePending is not null)
            return;
        if (fixture.FixtureScenario.Length == 0)
        {
            this.nativeLocalPlayerFixtureInitialized = true;
            return;
        }
        if (fixture.FixtureScenario == "navigation_read_only_v1")
        {
            // The direct Navigation gate needs an ordinary target-version world
            // with no fixture-created player or world facts. It only publishes
            // the two read-only operations after the native load is complete.
            this.nativeLocalPlayerFixtureInitialized = true;
            return;
        }
        if (fixture.FixtureScenario is not ("native_till_soil_v1" or "native_water_crop_v1" or "native_plant_seed_v1" or "native_fertilize_tile_v1" or "native_harvest_crop_v1" or "native_pickup_forage_v1" or "native_pickup_item_v1" or "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1" or "native_npc_relationship_v1" or "native_pet_animal_v1" or "native_use_item_v1" or "native_place_wood_fence_v1" or "native_chop_tree_source_v1" or "native_break_rock_source_v1" or "native_clear_hoedirt_v1" or "native_feed_animal_v1" or "native_collect_animal_product_v1" or "native_dig_artifact_spot_v1" or "native_place_crab_pot_v1" or "native_bait_crab_pot_v1") || Game1.player is null || Game1.getFarm() is not Farm farm)
        {
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log("GameBuddy native-local-player fixture rejected an unsupported or unavailable pre-attachment scenario.", LogLevel.Error);
            return;
        }
        try
        {
            Farmer player = Game1.player;
            if (fixture.FixtureScenario == "native_npc_relationship_v1")
            {
                // Establish a disposable, player-visible starting state only:
                // a naturally-loaded villager and a persisted relationship
                // fact. Production remains a read-only bridge inspection.
                InitializeNativeLocalNpcRelationshipFixture(player, farm);
                return;
            }
            if (fixture.FixtureScenario == "native_pet_animal_v1")
            {
                // Establish an unpetted native Pet only. Production alone calls
                // Pet.checkAction, records the daily interaction, applies
                // friendship, and emits a matching terminal receipt.
                InitializeNativeLocalPetFixture(player, farm);
                return;
            }
            if (player.MaxItems < 36)
                player.increaseBackpackSize(36 - player.MaxItems);

            if (fixture.FixtureScenario == "native_till_soil_v1")
            {
                if (!player.Items.OfType<Hoe>().Any() && player.addItemToInventory(new Hoe()) is not null)
                    throw new InvalidOperationException("fixture_native_local_hoe_inventory_full");
                if (!player.Items.OfType<Hoe>().Any())
                    throw new InvalidOperationException("fixture_native_local_hoe_missing_after_add");
                GameLocation? previousLocation = Game1.currentLocation;
                try
                {
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("RemoveDirt", null))
                        throw new InvalidOperationException("fixture_native_remove_dirt_command_unavailable");
                }
                finally { Game1.currentLocation = previousLocation; }
                bool groundExists = Enumerable.Range(0, farm.map.Layers[0].LayerWidth)
                    .SelectMany(x => Enumerable.Range(0, farm.map.Layers[0].LayerHeight).Select(y => new Vector2(x, y)))
                    .Any(tile => farm.GetHoeDirtAtTile(tile) is null
                        && farm.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Diggable", "Back") is not null
                        && !farm.isWaterTile((int)tile.X, (int)tile.Y));
                if (!groundExists)
                    throw new InvalidOperationException("fixture_native_tillable_soil_missing");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log("GameBuddy native-local-player initialized native till-soil fixture before bridge attachment: Hoe equipped candidate available; production alone creates HoeDirt and receipt.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_place_wood_fence_v1")
            {
                const string fenceId = "(O)322";
                if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fenceId && item.Stack > 0)
                    && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(fenceId, 1)) is not null)
                    throw new InvalidOperationException("fixture_native_local_wood_fence_inventory_full");
                if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fenceId && item.Stack > 0))
                    throw new InvalidOperationException("fixture_native_local_wood_fence_missing_after_add");
                bool targetExists = player.Items.Select((item, slot) => (item, slot)).Any(pair => pair.item is StardewValley.Object source
                    && source.QualifiedItemId == fenceId && source.Stack > 0
                    && Enumerable.Range(Math.Max(0, player.TilePoint.X - 1), 3).SelectMany(x => Enumerable.Range(Math.Max(0, player.TilePoint.Y - 1), 3).Select(y => new Vector2(x, y)))
                        .Any(tile => farm.isTileOnMap(tile) && !farm.objects.ContainsKey(tile) && farm.isTilePassable(tile)
                            && new[] { tile + new Vector2(1f, 0f), tile + new Vector2(-1f, 0f), tile + new Vector2(0f, 1f), tile + new Vector2(0f, -1f) }.Any(stance => farm.isTileOnMap(stance) && farm.isTilePassable(stance))));
                if (!targetExists)
                    throw new InvalidOperationException("fixture_native_local_wood_fence_target_missing");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized wood-fence fixture before bridge attachment: item={fenceId}; production alone invokes native placement, consumes one item, and emits receipt.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_bait_crab_pot_v1")
            {
                // Pre-attachment fixture only: create one current-player-owned,
                // unbaited (O)710 Crab Pot and one (O)685 Bait. Production alone
                // invokes checkAction and owns all attachment/consumption evidence.
                const string baitId = "(O)685";
                (Vector2 TargetTile, Vector2 StandingTile)? selected = FindNativeLocalCrabPotFixtureTarget(farm);
                if (selected is null) throw new InvalidOperationException("fixture_native_local_bait_crab_pot_target_missing");
                Vector2 targetTile = selected.Value.TargetTile;
                StardewValley.Objects.CrabPot pot = new();
                pot.owner.Value = player.UniqueMultiplayerID;
                farm.objects.Add(targetTile, pot);
                if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(baitId, 1)) is not null) throw new InvalidOperationException("fixture_native_local_bait_inventory_full");
                StardewValley.Object? bait = player.Items.OfType<StardewValley.Object>().SingleOrDefault(item => item.QualifiedItemId == baitId && item.Stack == 1);
                if (bait is null || pot.bait.Value is not null || pot.owner.Value != player.UniqueMultiplayerID) throw new InvalidOperationException("fixture_native_local_bait_crab_pot_precondition_failed");
                player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)selected.Value.StandingTile.X, (int)selected.Value.StandingTile.Y, false));
                this.nativeLocalBaitCrabPotFixturePending = new NativeLocalBaitCrabPotFixturePending(farm.NameOrUniqueName, targetTile, selected.Value.StandingTile, pot, bait, player.UniqueMultiplayerID);
                return;
            }

            if (fixture.FixtureScenario == "native_place_crab_pot_v1")
            {
                // Supply exactly one untouched (O)710. This branch only scans
                // the live Farm with CrabPot's exact target-version predicate,
                // validates one cardinal stance, and completes a native warp.
                // It performs no target mutation, inventory decrement, output
                // generation, or execution evidence.
                const string crabPotId = "(O)710";
                Item?[] inventoryBefore = player.Items.ToArray();
                int[] inventoryStacksBefore = inventoryBefore.Select(item => item?.Stack ?? -1).ToArray();
                string?[] inventoryIdsBefore = inventoryBefore.Select(item => item?.QualifiedItemId).ToArray();
                StardewValley.Object[] existingCrabPots = inventoryBefore
                    .OfType<StardewValley.Object>()
                    .Where(item => item.QualifiedItemId == crabPotId)
                    .ToArray();
                if (existingCrabPots.Length > 1)
                    throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_multiple_stacks");
                if (existingCrabPots.Length == 1 && existingCrabPots[0].Stack != 1)
                    throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_stack_must_be_exactly_one");

                // Never remove, rebuild, or replace an existing pot. A missing
                // pot is provisioned only once into a genuinely empty slot in
                // this disposable fresh-save fixture; every other inventory
                // identity and count must remain byte-for-byte equivalent.
                int addedCrabPotSlot = -1;
                if (existingCrabPots.Length == 0)
                {
                    int? emptyCrabPotSlot = Enumerable.Range(0, player.Items.Count)
                        .Where(slot => player.Items[slot] is null)
                        .Select(slot => (int?)slot)
                        .FirstOrDefault();
                    addedCrabPotSlot = emptyCrabPotSlot ?? -1;
                    if (addedCrabPotSlot < 0)
                        throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_empty_slot_required");
                    if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(crabPotId, 1)) is not null)
                        throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_add_failed");
                }
                Item?[] inventoryAfter = player.Items.ToArray();
                StardewValley.Object[] crabPotsAfter = inventoryAfter
                    .OfType<StardewValley.Object>()
                    .Where(item => item.QualifiedItemId == crabPotId && item.Stack > 0)
                    .ToArray();
                if (crabPotsAfter.Length != 1
                    || crabPotsAfter[0].Stack != 1
                    || (existingCrabPots.Length == 1 && !ReferenceEquals(existingCrabPots[0], crabPotsAfter[0]))
                    || (addedCrabPotSlot >= 0 && (!ReferenceEquals(inventoryBefore[addedCrabPotSlot], null)
                        || !ReferenceEquals(inventoryAfter[addedCrabPotSlot], crabPotsAfter[0]))))
                    throw new InvalidOperationException("fixture_native_local_crab_pot_inventory_postcondition_failed");
                StardewValley.Object crabPot = crabPotsAfter[0];
                int crabPotStack = crabPot.Stack;
                // Native inventory insertion may normalize unrelated item object
                // references. Preserve their slot/value facts (qualified ID and
                // stack), while retaining a strict object-identity invariant for
                // any pre-existing Crab Pot itself.
                for (int slot = 0; slot < inventoryBefore.Length; slot++)
                {
                    if (slot == addedCrabPotSlot)
                        continue;
                    if ((inventoryAfter[slot]?.Stack ?? -1) != inventoryStacksBefore[slot]
                        || inventoryAfter[slot]?.QualifiedItemId != inventoryIdsBefore[slot])
                        throw new InvalidOperationException($"fixture_native_local_crab_pot_inventory_changed:slot={slot};before_id={inventoryIdsBefore[slot] ?? "null"};before_stack={inventoryStacksBefore[slot]};after_id={inventoryAfter[slot]?.QualifiedItemId ?? "null"};after_stack={inventoryAfter[slot]?.Stack ?? -1}");
                }
                if (IsExcludedCrabPotLocation(farm))
                    throw new InvalidOperationException("fixture_native_local_crab_pot_location_rejected");
                (Vector2 TargetTile, Vector2 StandingTile)? selected = FindNativeLocalCrabPotFixtureTarget(farm);
                if (selected is null)
                    throw new InvalidOperationException("fixture_native_local_crab_pot_target_missing");
                GameLocation? crabPotPreviousLocation = Game1.currentLocation;
                try
                {
                    Game1.currentLocation = farm;
                    if (!StardewValley.Objects.CrabPot.IsValidCrabPotLocationTile(farm, (int)selected.Value.TargetTile.X, (int)selected.Value.TargetTile.Y))
                        throw new InvalidOperationException("fixture_native_local_crab_pot_target_revalidation_failed");
                }
                finally { Game1.currentLocation = crabPotPreviousLocation; }
                player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)selected.Value.StandingTile.X, (int)selected.Value.StandingTile.Y, false));
                this.nativeLocalPlaceCrabPotFixturePending = new NativeLocalPlaceCrabPotFixturePending(
                    farm.NameOrUniqueName,
                    selected.Value.TargetTile,
                    selected.Value.StandingTile,
                    crabPot,
                    crabPotStack,
                    inventoryAfter,
                    inventoryAfter.Select(item => item?.Stack ?? -1).ToArray(),
                    inventoryAfter.Select(item => item?.QualifiedItemId).ToArray());
                return;
            }

            if (fixture.FixtureScenario == "native_plant_seed_v1")
            {
                // This setup creates only a legal, empty HoeDirt target and a
                // normal seed stack. The typed production action alone
                // consumes the seed, creates the crop, and emits evidence.
                // The event-free template is Spring 1 Year 1, so this must be
                // an in-season seed; canPlantThisSeedHere remains authoritative.
                const string seedId = "(O)472";
                if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == seedId && item.Stack > 0)
                    && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(seedId, 2)) is not null)
                    throw new InvalidOperationException("fixture_native_local_seed_inventory_full");
                if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == seedId && item.Stack > 0))
                    throw new InvalidOperationException("fixture_native_local_seed_missing_after_add");
                GameLocation? seedSetupPreviousLocation = Game1.currentLocation;
                int eligibleDirtCount;
                try
                {
                    // Both target-version debug setup and HoeDirt's native
                    // season/location predicate are Farm-context operations.
                    // Restore the actual player location before bridge attach.
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("RemoveDirt", null) || !Game1.game1.parseDebugInput("SpreadDirt", null))
                        throw new InvalidOperationException("fixture_native_local_empty_dirt_command_unavailable");
                    // The actual Farmer remains in FarmHouse until the
                    // separately receipted travel prerequisite. Do not call
                    // canPlantThisSeedHere here: target-version evaluates it
                    // against the live actor/location. Require only empty
                    // native dirt now; the production snapshot and action
                    // revalidate plantability after the Farmer reaches Farm.
                    eligibleDirtCount = farm.terrainFeatures.Pairs.Count(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                        && dirt.crop is null
                        && !(farm.objects.TryGetValue(pair.Key, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot));
                }
                finally { Game1.currentLocation = seedSetupPreviousLocation; }
                if (eligibleDirtCount == 0)
                    throw new InvalidOperationException("fixture_native_local_seed_target_missing");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized native plant-seed fixture before bridge attachment: seed={seedId}; eligible_empty_dirt_count={eligibleDirtCount}; production alone plants, consumes, creates crop, and emits receipt.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_fertilize_tile_v1")
            {
                // Supply only the normal fertilizer stack and native, empty
                // HoeDirt. Applying fertilizer remains exclusively production.
                const string fertilizerId = "(O)368";
                if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fertilizerId && item.Stack > 0)
                    && player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(fertilizerId, 2)) is not null)
                    throw new InvalidOperationException("fixture_native_local_fertilizer_inventory_full");
                if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == fertilizerId && item.Stack > 0))
                    throw new InvalidOperationException("fixture_native_local_fertilizer_missing_after_add");
                GameLocation? fertilizerSetupPreviousLocation = Game1.currentLocation;
                int eligibleDirtCount;
                try
                {
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("RemoveDirt", null) || !Game1.game1.parseDebugInput("SpreadDirt", null))
                        throw new InvalidOperationException("fixture_native_local_fertilizer_dirt_command_unavailable");
                    eligibleDirtCount = farm.terrainFeatures.Pairs.Count(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                        && dirt.crop is null
                        && dirt.CanApplyFertilizer(fertilizerId)
                        && !(farm.objects.TryGetValue(pair.Key, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot));
                }
                finally { Game1.currentLocation = fertilizerSetupPreviousLocation; }
                if (eligibleDirtCount == 0)
                    throw new InvalidOperationException("fixture_native_local_fertilizer_target_missing");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized native fertilize-tile fixture before bridge attachment: fertilizer={fertilizerId}; eligible_empty_dirt_count={eligibleDirtCount}; production alone applies fertilizer and emits receipt.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_harvest_crop_v1")
            {
                // Target-version commands create a ready ordinary crop only;
                // production alone performs use/harvest and changes inventory.
                GameLocation? harvestSetupPreviousLocation = Game1.currentLocation;
                try
                {
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("RemoveDirt", null)
                        || !Game1.game1.parseDebugInput("SpreadDirt", null)
                        || !Game1.game1.parseDebugInput("SpreadSeeds 472", null)
                        || !Game1.game1.parseDebugInput("GrowCrops 6", null))
                        throw new InvalidOperationException("fixture_native_local_harvest_crop_setup_unavailable");
                }
                finally { Game1.currentLocation = harvestSetupPreviousLocation; }
                KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>? selected = farm.terrainFeatures.Pairs
                    .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                        && dirt.crop is not null
                        && !dirt.crop.forageCrop.Value
                        && dirt.readyForHarvest()
                        && dirt.crop.GetHarvestMethod() == StardewValley.GameData.Crops.HarvestMethod.Grab
                        && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value))
                    .Select(pair => new KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>(pair.Key, (StardewValley.TerrainFeatures.HoeDirt)pair.Value))
                    .Cast<KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>?>()
                    .FirstOrDefault();
                if (selected is null || selected.Value.Value.crop is null)
                    throw new InvalidOperationException("fixture_native_local_ready_grab_crop_missing");
                StardewValley.Item harvestItem;
                try { harvestItem = ItemRegistry.Create(selected.Value.Value.crop.indexOfHarvest.Value, 1); }
                catch (Exception) { throw new InvalidOperationException("fixture_native_local_harvest_item_missing"); }
                if (!player.couldInventoryAcceptThisItem(harvestItem))
                    throw new InvalidOperationException("fixture_native_local_harvest_inventory_unavailable");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized native harvest-crop fixture before bridge attachment: selected={selected.Value.Value.crop.netSeedIndex.Value ?? "unknown"}@{(int)selected.Value.Key.X},{(int)selected.Value.Key.Y}; harvest={harvestItem.QualifiedItemId}; ready=true; production alone harvests and emits receipt.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_pickup_forage_v1")
            {
                // Resolve the Farm target from this actual local Player's live
                // FarmHouse warp without relying on another actor or building.
                if (player.currentLocation is not StardewValley.Locations.FarmHouse farmHouse)
                    throw new InvalidOperationException("fixture_native_local_pickup_forage_farmhouse_missing");
                StardewValley.Warp? farmWarp = farmHouse.warps.FirstOrDefault(warp => !warp.npcOnly.Value
                    && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
                if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
                    throw new InvalidOperationException("fixture_native_local_pickup_forage_farm_warp_missing");
                Vector2 farmArrival = new(farmWarp.TargetX, farmWarp.TargetY);
                // Arrival geometry is target-version map data, not a fixture
                // contract. Search a bounded radius for a legal setup location,
                // while leaving final placement authority to native dropObject.
                const int placementRadius = 8;
                Vector2[] candidateTiles = Enumerable.Range(-placementRadius, placementRadius * 2 + 1)
                    .SelectMany(offsetX => Enumerable.Range(-placementRadius, placementRadius * 2 + 1)
                        .Select(offsetY => new Vector2(farmArrival.X + offsetX, farmArrival.Y + offsetY)))
                    .Where(tile => tile != farmArrival
                        && farm.isTileOnMap(tile)
                        && !farm.objects.ContainsKey(tile))
                    .Where(tile => new[]
                    {
                        tile + new Vector2(1f, 0f),
                        tile + new Vector2(-1f, 0f),
                        tile + new Vector2(0f, 1f),
                        tile + new Vector2(0f, -1f),
                    }.Any(approach => farm.isTileOnMap(approach)
                        && farm.isTilePassable(approach)
                        && !farm.IsTileOccupiedBy(approach, CollisionMask.All, CollisionMask.None, useFarmerTile: true)))
                    .OrderBy(tile => Math.Max(Math.Abs(tile.X - farmArrival.X), Math.Abs(tile.Y - farmArrival.Y)))
                    .ThenBy(tile => Math.Abs(tile.X - farmArrival.X) + Math.Abs(tile.Y - farmArrival.Y))
                    .ToArray();
                string[] forageIds = new[] { "(O)399", "(O)396", "(O)398", "(O)16", "(O)18", "(O)20", "(O)22" };
                Vector2 placedTile = Vector2.Zero;
                StardewValley.Object? placedForage = null;
                foreach (Vector2 tile in candidateTiles)
                {
                    foreach (string forageId in forageIds)
                    {
                        StardewValley.Object forage = ItemRegistry.Create<StardewValley.Object>(forageId, 1);
                        if (!forage.isForage())
                            continue;
                        if (!player.couldInventoryAcceptThisItem(forage))
                            throw new InvalidOperationException("fixture_native_local_pickup_forage_inventory_unavailable");
                        if (!farm.dropObject(forage, tile * 64f, Game1.viewport, initialPlacement: true))
                            continue;
                        if (farm.objects.TryGetValue(tile, out StardewValley.Object? actual)
                            && ReferenceEquals(actual, forage)
                            && actual.QualifiedItemId == forageId
                            && actual.isForage()
                            && actual.IsSpawnedObject)
                        {
                            placedTile = tile;
                            placedForage = actual;
                            break;
                        }
                        throw new InvalidOperationException("fixture_native_local_pickup_forage_placement_validation_failed");
                    }
                    if (placedForage is not null)
                        break;
                }
                if (placedForage is null)
                    throw new InvalidOperationException("fixture_native_local_pickup_forage_placement_missing");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized pickup-forage precondition before bridge attachment: forage={placedForage.QualifiedItemId}; tile={(int)placedTile.X},{(int)placedTile.Y}; spawned={placedForage.IsSpawnedObject}.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_pickup_item_v1")
            {
                // Derive this local-only drop from the current Player's actual
                // FarmHouse→Farm warp. createItemDebris owns native chunk setup;
                // no collection, removal, or inventory outcome is performed here.
                if (player.currentLocation is not StardewValley.Locations.FarmHouse itemFarmHouse)
                    throw new InvalidOperationException("fixture_native_local_pickup_item_farmhouse_missing");
                StardewValley.Warp? itemFarmWarp = itemFarmHouse.warps.FirstOrDefault(warp => !warp.npcOnly.Value
                    && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
                if (itemFarmWarp is null || itemFarmWarp.TargetX < 0 || itemFarmWarp.TargetY < 0)
                    throw new InvalidOperationException("fixture_native_local_pickup_item_farm_warp_missing");
                Vector2 itemArrival = new(itemFarmWarp.TargetX, itemFarmWarp.TargetY);
                // Discovery is bounded to six tiles by the production bridge;
                // place within that native-local discovery radius, while the
                // production pickup still drives its own native approach.
                Vector2? itemTile = FindNativeLocalFarmFixtureTile(farm, itemArrival, 6, requireEmptyObjectTile: true);
                if (itemTile is null)
                    throw new InvalidOperationException("fixture_native_local_pickup_item_placement_missing");
                const string itemId = "(O)388";
                StardewValley.Object item = ItemRegistry.Create<StardewValley.Object>(itemId, 1);
                if (!player.couldInventoryAcceptThisItem(item))
                    throw new InvalidOperationException("fixture_native_local_pickup_item_inventory_unavailable");
                int debrisBefore = farm.debris.Count;
                StardewValley.Debris debris = Game1.createItemDebris(item, itemTile.Value * 64f + new Vector2(32f, 32f), 2, farm, (int)(itemTile.Value.Y * 64f + 32f));
                if (farm.debris.Count != debrisBefore + 1 || !farm.debris.Contains(debris)
                    || debris.debrisType.Value != StardewValley.Debris.DebrisType.OBJECT || debris.Chunks.Count == 0
                    || debris.item is null || debris.item.QualifiedItemId != itemId || debris.item.Stack != 1)
                    throw new InvalidOperationException("fixture_native_local_pickup_item_debris_setup_missing");
                // No dropped-by identity/grace override is used in this topology:
                // it would encode an actor assumption rather than a setup fact.
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized pickup-item precondition before bridge attachment: item={itemId}; tile={(int)itemTile.Value.X},{(int)itemTile.Value.Y}; debris_type={debris.debrisType.Value}; chunks={debris.Chunks.Count}.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario is "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1")
            {
                // Machine inspection/loading are local to any loaded GameLocation. Keep this
                // fixture in the initial FarmHouse so its target is fresh and
                // adjacent before attachment; a Farm warp is not a machine
                // precondition and must not become hidden fixture authority.
                GameLocation? machineLocation = player.currentLocation;
                if (machineLocation is null)
                    throw new InvalidOperationException("fixture_native_local_machine_location_missing");
                Vector2? machineTile = FindNativeLocalFarmFixtureTile(machineLocation, player.Tile, 1, requireEmptyObjectTile: true);
                if (machineTile is null)
                    throw new InvalidOperationException("fixture_native_local_machine_placement_missing");
                StardewValley.Object machine = ItemRegistry.Create<StardewValley.Object>("(BC)12", 1);
                if (machine.GetMachineData() is null || !machineLocation.dropObject(machine, machineTile.Value * 64f, Game1.viewport, initialPlacement: true)
                    || !machineLocation.objects.TryGetValue(machineTile.Value, out StardewValley.Object? placedMachine)
                    || !ReferenceEquals(machine, placedMachine) || placedMachine.GetMachineData() is null)
                    throw new InvalidOperationException("fixture_native_local_machine_setup_missing");
                if (fixture.FixtureScenario == "native_machine_coffee_load_v1")
                {
                    // This is only the owned exact-stack input precondition.
                    // Production alone invokes the normal machine interaction
                    // ingress and proves native consumption/processing.
                    StardewValley.Object coffeeBeans = ItemRegistry.Create<StardewValley.Object>("(O)433", 5);
                    if (player.addItemToInventory(coffeeBeans) is not null || player.Items.OfType<StardewValley.Object>().Count(item => item.QualifiedItemId == "(O)433" && item.Stack == 5) != 1)
                        throw new InvalidOperationException("fixture_native_local_machine_coffee_input_missing");
                }
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized {(fixture.FixtureScenario == "native_machine_coffee_load_v1" ? "machine-coffee-load" : fixture.FixtureScenario == "native_machine_coffee_collect_v1" ? "machine-coffee-collect" : "machine-inspect")} precondition before bridge attachment: machine={placedMachine.QualifiedItemId}; tile={(int)machineTile.Value.X},{(int)machineTile.Value.Y}; ready={placedMachine.readyForHarvest.Value}; minutes_until_ready={placedMachine.MinutesUntilReady}.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_dig_artifact_spot_v1")
            {
                foreach (Item? ownedItem in player.Items.Where(item => item is Hoe).ToArray()) player.Items.Remove(ownedItem);
                if (player.addItemToInventory(new Hoe()) is not null || player.Items.OfType<Hoe>().Count() != 1 || player.Items.OfType<Hoe>().Single().UpgradeLevel != 0)
                    throw new InvalidOperationException("fixture_native_local_artifact_spot_hoe_missing_or_ambiguous");

                // SetupBigFarm may restore zero, one, or many artifact spots.
                // Never remove or pre-consume an existing source: sort every Farm
                // source by coordinate and select the first one satisfying the
                // exact native precondition. Invalid or unreachable sources do
                // not get repaired; a valid later source may still be selected.
                KeyValuePair<Vector2, StardewValley.Object>[] existingArtifactSpots = farm.objects.Pairs
                    .Where(pair => pair.Value.QualifiedItemId == "(O)590")
                    .OrderBy(pair => pair.Key.X)
                    .ThenBy(pair => pair.Key.Y)
                    .ToArray();
                Vector2 artifactTile;
                Vector2 standingTile;
                if (existingArtifactSpots.Length == 0)
                {
                    Vector2? placedTile = FindNativeLocalFarmFixtureTile(farm, new Vector2(64f, 15f), 12, requireEmptyObjectTile: true,
                        extraPredicate: candidate => !farm.terrainFeatures.ContainsKey(candidate));
                    if (placedTile is null)
                        throw new InvalidOperationException("fixture_native_local_artifact_spot_placement_missing");
                    artifactTile = placedTile.Value;
                    StardewValley.Object artifact = ItemRegistry.Create<StardewValley.Object>("(O)590", 1);
                    if (!farm.dropObject(artifact, artifactTile * 64f, Game1.viewport, initialPlacement: false)
                        || !farm.objects.TryGetValue(artifactTile, out StardewValley.Object? placed)
                        || !ReferenceEquals(artifact, placed) || placed.QualifiedItemId != "(O)590")
                        throw new InvalidOperationException("fixture_native_local_artifact_spot_placement_validation_failed");
                    standingTile = FindNativeLocalArtifactSpotStandingTile(farm, artifactTile)
                        ?? throw new InvalidOperationException("fixture_native_local_artifact_spot_approach_missing");
                }
                else
                {
                    (Vector2 Tile, Vector2 StandingTile)? selected = existingArtifactSpots
                        .Select(pair => FindNativeLocalArtifactSpotStandingTile(farm, pair.Key) is Vector2 approach
                            ? (Tile: pair.Key, StandingTile: approach)
                            : ((Vector2 Tile, Vector2 StandingTile)?)null)
                        .FirstOrDefault(candidate => candidate is not null);
                    if (selected is null)
                        throw new InvalidOperationException("fixture_native_local_artifact_spot_existing_sources_unapproachable");
                    artifactTile = selected.Value.Tile;
                    standingTile = selected.Value.StandingTile;
                }
                int artifactSourceCount = farm.objects.Pairs.Count(pair => pair.Value.QualifiedItemId == "(O)590");
                if (artifactSourceCount < 1
                    || !farm.objects.TryGetValue(artifactTile, out StardewValley.Object? intactArtifact)
                    || intactArtifact.QualifiedItemId != "(O)590"
                    || !farm.isTileOnMap(artifactTile)
                    || farm.terrainFeatures.ContainsKey(artifactTile)
                    || farm.GetHoeDirtAtTile(artifactTile) is not null
                    || intactArtifact is StardewValley.Objects.IndoorPot
                    || player.Items.OfType<Hoe>().Count() != 1
                    || player.Items.OfType<Hoe>().Single().UpgradeLevel != 0)
                    throw new InvalidOperationException("fixture_native_local_artifact_spot_postsetup_validation_failed");
                player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standingTile.X, (int)standingTile.Y, false));
                this.nativeLocalDigArtifactSpotFixturePending = new NativeLocalDigArtifactSpotFixturePending(farm.NameOrUniqueName, artifactTile, standingTile);
                return;
            }

            if (fixture.FixtureScenario == "native_clear_hoedirt_v1")
            {
                // Establish only one intact, empty ground HoeDirt and exactly
                // one Basic Pickaxe before bridge attachment. Production alone
                // invokes Pickaxe.DoFunction and proves terrain removal.
                foreach (Item? ownedItem in player.Items.Where(item => item is Pickaxe).ToArray()) player.Items.Remove(ownedItem);
                if (player.addItemToInventory(new Pickaxe()) is not null || player.Items.OfType<Pickaxe>().Count() != 1) throw new InvalidOperationException("fixture_native_local_clear_hoedirt_pickaxe_missing_or_ambiguous");
                // The FarmHouse→Farm native warp arrives at 64,15, but actual
                // map passability/content determines a lawful source and its
                // adjacent standing tile. Positioning is a pre-attachment fact
                // only: production alone hits/removes the HoeDirt, changes no
                // inventory, and emits the authoritative receipt.
                Vector2 fixtureArrival = new(64f, 15f);
                Vector2? dirtTile = FindNativeLocalFarmFixtureTile(farm, fixtureArrival, 12, requireEmptyObjectTile: true,
                    extraPredicate: candidate => !farm.terrainFeatures.ContainsKey(candidate) && farm.doesTileHaveProperty((int)candidate.X, (int)candidate.Y, "Diggable", "Back") is not null && !farm.isWaterTile((int)candidate.X, (int)candidate.Y));
                if (dirtTile is null) throw new InvalidOperationException("fixture_native_local_clear_hoedirt_placement_missing");
                Vector2[] standingCandidates = new[]
                {
                    dirtTile.Value + new Vector2(-1f, 0f), dirtTile.Value + new Vector2(1f, 0f),
                    dirtTile.Value + new Vector2(0f, -1f), dirtTile.Value + new Vector2(0f, 1f),
                };
                Vector2? standingTile = standingCandidates
                    .Where(candidate => farm.isTileOnMap(candidate) && farm.isTilePassable(candidate)
                        && !farm.IsTileOccupiedBy(candidate, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
                    .Cast<Vector2?>()
                    .FirstOrDefault();
                if (standingTile is null) throw new InvalidOperationException("fixture_native_local_clear_hoedirt_approach_missing");
                StardewValley.TerrainFeatures.HoeDirt dirt = new();
                farm.terrainFeatures.Add(dirtTile.Value, dirt);
                if (!farm.terrainFeatures.TryGetValue(dirtTile.Value, out StardewValley.TerrainFeatures.TerrainFeature? placedFeature) || !ReferenceEquals(placedFeature, dirt) || dirt.crop is not null || (farm.objects.TryGetValue(dirtTile.Value, out StardewValley.Object? placedObject) && placedObject is StardewValley.Objects.IndoorPot)) throw new InvalidOperationException("fixture_native_local_clear_hoedirt_placement_validation_failed");
                // Complete the normal FarmHouse→Farm warp first. Its later
                // OnWarped continuation validates this exact lawful approach
                // and adjusts only the Player position; it never hits/removes
                // the target, changes inventory, or creates a receipt.
                player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, (int)standingTile.Value.X, (int)standingTile.Value.Y, false));
                this.nativeLocalClearHoeDirtFixturePending = new NativeLocalClearHoeDirtFixturePending(farm.NameOrUniqueName, dirtTile.Value, standingTile.Value);
                return;
            }

            if (fixture.FixtureScenario == "native_break_rock_source_v1")
            {
                foreach (Item? ownedItem in player.Items.Where(item => item is Pickaxe).ToArray()) player.Items.Remove(ownedItem);
                if (player.addItemToInventory(new Pickaxe()) is not null || player.Items.OfType<Pickaxe>().Count() != 1) throw new InvalidOperationException("fixture_native_local_basic_pickaxe_missing_or_ambiguous");
                Vector2? rockTile = FindNativeLocalFarmFixtureTile(farm, new Vector2(64f, 15f), 12, requireEmptyObjectTile: true);
                if (rockTile is null || farm.objects.ContainsKey(rockTile.Value)) throw new InvalidOperationException("fixture_native_local_rock_placement_missing");
                StardewValley.Object rock = ItemRegistry.Create<StardewValley.Object>("(O)2", 1);
                rock.MinutesUntilReady = 1;
                farm.objects.Add(rockTile.Value, rock);
                if (!farm.objects.TryGetValue(rockTile.Value, out StardewValley.Object? placed) || !ReferenceEquals(placed, rock) || placed.QualifiedItemId != "(O)2" || !placed.IsBreakableStone() || placed.MinutesUntilReady != 1) throw new InvalidOperationException("fixture_native_local_rock_placement_validation_failed");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized break-rock-source precondition before bridge attachment: tile={(int)rockTile.Value.X},{(int)rockTile.Value.Y}; item=(O)2; durability=1; production alone invokes exactly one Pickaxe hit and emits receipt.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_clear_debris_resource_clump_v1")
            {
                // This narrow pre-attachment recipe mirrors the target-version
                // GameLocation placement lifecycle: it establishes one intact,
                // default-health mine rock. Production alone performs every
                // Pickaxe hit, all health decrements/removal, and its receipt.
                const int debrisParentSheetIndex = 752;
                const int debrisWidth = 2;
                const int debrisHeight = 2;
                const int debrisDefaultHealth = 8;
                foreach (Item? ownedItem in player.Items.Where(item => item is Pickaxe).ToArray())
                    player.Items.Remove(ownedItem);
                if (player.addItemToInventory(new Pickaxe()) is not null || player.Items.OfType<Pickaxe>().Count() != 1)
                    throw new InvalidOperationException("fixture_native_local_debris_pickaxe_missing_or_ambiguous");
                // The versioned template owns this exact origin and the three
                // reviewed outside interaction anchors in its runner. Never
                // search for a substitute tile: unavailable/occupied fixture
                // geometry blocks the run before bridge attachment.
                Vector2 debrisTile = new(62f, 17f);
                if (!Enumerable.Range(0, debrisWidth).SelectMany(footprintX => Enumerable.Range(0, debrisHeight)
                    .Select(footprintY => new Vector2(debrisTile.X + footprintX, debrisTile.Y + footprintY)))
                    .All(footprint => farm.CanItemBePlacedHere(footprint, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true)))
                    throw new InvalidOperationException("fixture_native_local_debris_fixed_placement_unavailable");
                if (farm.resourceClumps.Any(existing => existing.parentSheetIndex.Value == debrisParentSheetIndex))
                    throw new InvalidOperationException("fixture_native_local_debris_parent_already_present");
                int clumpsBefore = farm.resourceClumps.Count;
                // addResourceClumpAndRemoveUnderlyingTerrain is the pinned
                // target-version placement API; no direct list insertion or
                // health mutation is permitted in this fixture.
                farm.addResourceClumpAndRemoveUnderlyingTerrain(debrisParentSheetIndex, debrisWidth, debrisHeight, debrisTile);
                if (farm.resourceClumps.Count != clumpsBefore + 1
                    || farm.resourceClumps[clumpsBefore] is not StardewValley.TerrainFeatures.ResourceClump clump
                    || clump.parentSheetIndex.Value != debrisParentSheetIndex
                    || clump.width.Value != debrisWidth || clump.height.Value != debrisHeight
                    || clump.Tile != debrisTile || clump.health.Value != debrisDefaultHealth)
                    throw new InvalidOperationException("fixture_native_local_debris_placement_validation_failed");
                // The fixture transaction owns the empty template. It does not
                // move the Player, hit a clump, select a tool, emit a receipt,
                // or create a production postcondition.
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized clear-debris precondition before bridge attachment: parent={debrisParentSheetIndex}; tile={(int)debrisTile.X},{(int)debrisTile.Y}; size={debrisWidth}x{debrisHeight}; health={clump.health.Value:0}; pickaxe_upgrade=0; production alone invokes the finite native Pickaxe-hit sequence, removes the clump, and emits receipts.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario is "native_chop_tree_source_v1")
            {
                foreach (Item? ownedItem in player.Items.Where(item => item is Axe).ToArray())
                    player.Items.Remove(ownedItem);
                if (player.addItemToInventory(new Axe()) is not null)
                    throw new InvalidOperationException("fixture_native_local_axe_inventory_full");
                if (player.Items.OfType<Axe>().Count() != 1)
                    throw new InvalidOperationException("fixture_native_local_axe_missing_or_ambiguous_after_add");
                // The runner requires exactly one fresh full-health tree source
                // after it approaches this setup tile. Exclude every existing
                // tree from the Chebyshev-2 neighborhood: any legal adjacent
                // approach tile then sees only this tree within discovery radius.
                Vector2? treeTile = FindNativeLocalFarmFixtureTile(
                    farm,
                    new Vector2(64f, 15f),
                    12,
                    requireEmptyObjectTile: false,
                    extraPredicate: candidate => !farm.terrainFeatures.Pairs.Any(pair => pair.Value is StardewValley.TerrainFeatures.Tree
                        && Math.Max(Math.Abs(pair.Key.X - candidate.X), Math.Abs(pair.Key.Y - candidate.Y)) <= 2f));
                if (treeTile is null || farm.terrainFeatures.ContainsKey(treeTile.Value))
                    throw new InvalidOperationException("fixture_native_local_tree_placement_missing");
                StardewValley.TerrainFeatures.Tree tree = new("1", StardewValley.TerrainFeatures.Tree.treeStage);
                float fixtureHealth = 1f;
                tree.health.Value = fixtureHealth;
                farm.terrainFeatures.Add(treeTile.Value, tree);
                if (!farm.terrainFeatures.TryGetValue(treeTile.Value, out StardewValley.TerrainFeatures.TerrainFeature? placed)
                    || !ReferenceEquals(placed, tree) || tree.stump.Value || tree.growthStage.Value < StardewValley.TerrainFeatures.Tree.treeStage
                    || tree.hasMoss.Value || tree.tapped.Value || tree.health.Value != fixtureHealth)
                    throw new InvalidOperationException("fixture_native_local_tree_placement_validation_failed");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized chop-tree-source precondition before bridge attachment: tile={(int)treeTile.Value.X},{(int)treeTile.Value.Y}; health={fixtureHealth:0}; moss=false; tapped=false; production alone invokes exactly one Axe hit and emits receipt.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_use_item_v1")
            {
                if (player.MaxItems < 36)
                    player.increaseBackpackSize(36 - player.MaxItems);
                const string foodId = "(O)216";
                StardewValley.Object? food = player.Items.OfType<StardewValley.Object>().FirstOrDefault(candidate => candidate.QualifiedItemId == foodId && candidate.Stack > 0);
                if (food is null)
                {
                    StardewValley.Object suppliedFood = ItemRegistry.Create<StardewValley.Object>(foodId, 1);
                    if (player.addItemToInventory(suppliedFood) is not null)
                        throw new InvalidOperationException("fixture_native_local_use_item_inventory_full");
                    food = player.Items.OfType<StardewValley.Object>().FirstOrDefault(candidate => candidate.QualifiedItemId == foodId && candidate.Stack > 0);
                }
                if (food is null || food.Edibility < 0 || (Game1.objectData.TryGetValue(food.ItemId, out var foodData) && foodData.IsDrink))
                    throw new InvalidOperationException("fixture_native_local_use_item_food_missing");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized use-item precondition before bridge attachment: food={food.QualifiedItemId}; stack={food.Stack}; edibility={food.Edibility}; inventory_slots={player.MaxItems}.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario == "native_feed_animal_v1")
            {
                // This disposable native-local branch may use the pinned
                // target-version SetupBigFarm entrypoint solely to construct an
                // AnimalHouse/world entry precondition. It neither invokes
                // the native feed ingress nor fills a trough, consumes Hay,
                // creates a receipt, or changes feed_animal's postcondition.
                GameLocation? feedSetupPreviousLocation = Game1.currentLocation;
                try
                {
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("SetupBigFarm", null))
                        throw new InvalidOperationException("fixture_native_feed_animal_setup_unavailable");
                }
                finally { Game1.currentLocation = feedSetupPreviousLocation; }

                StardewValley.Buildings.Building[] animalBuildings = farm.buildings
                    .Where(building => building.GetIndoors() is StardewValley.AnimalHouse)
                    .ToArray();
                // The pinned target-version SetupBigFarm source places Deluxe
                // Barns at (16,9) and (3,16). Building interiors are instanced,
                // so NameOrUniqueName is deliberately not a stable selector.
                // Select only the source-defined first Deluxe Barn placement;
                // do not guess a generated interior name or mutate the other
                // native buildings.
                StardewValley.Buildings.Building[] configuredBarns = animalBuildings
                    .Where(building => string.Equals(building.buildingType.Value, "Deluxe Barn", StringComparison.Ordinal)
                        && building.tileX.Value == 16
                        && building.tileY.Value == 9)
                    .ToArray();
                if (configuredBarns.Length != 1 || configuredBarns[0].GetIndoors() is not StardewValley.AnimalHouse animalHouse)
                    throw new InvalidOperationException("fixture_native_feed_animal_house_missing_or_ambiguous");
                Microsoft.Xna.Framework.Point entryPoint = configuredBarns[0].getPointForHumanDoor();
                StardewValley.Warp? entryWarp = farm.getWarpFromDoor(entryPoint, player);
                if (entryWarp is null || !string.Equals(entryWarp.TargetName, animalHouse.NameOrUniqueName, StringComparison.Ordinal)
                    || entryPoint.X < 0 || entryPoint.Y < 0 || !farm.isTileOnMap(new Vector2(entryPoint.X, entryPoint.Y))
                    || entryWarp.TargetX < 0 || entryWarp.TargetY < 0 || !animalHouse.isTileOnMap(new Vector2(entryWarp.TargetX, entryWarp.TargetY)))
                    throw new InvalidOperationException("fixture_native_feed_animal_entry_unresolvable");
                xTile.Layers.Layer? backLayer = animalHouse.map.GetLayer("Back");
                if (backLayer is null)
                    throw new InvalidOperationException("fixture_native_feed_animal_trough_layer_missing");
                Vector2[] emptyTroughs = Enumerable.Range(0, backLayer.LayerWidth)
                    .SelectMany(x => Enumerable.Range(0, backLayer.LayerHeight).Select(y => new Vector2(x, y)))
                    .Where(tile => animalHouse.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Trough", "Back") is not null
                        && !animalHouse.objects.ContainsKey(tile))
                    .OrderBy(tile => tile.Y).ThenBy(tile => tile.X)
                    .ToArray();
                if (emptyTroughs.Length == 0)
                    throw new InvalidOperationException("fixture_native_feed_animal_empty_trough_missing");
                Vector2 trough = emptyTroughs[0];
                Vector2[] standingCandidates = new[]
                {
                    trough + new Vector2(0f, 1f), trough + new Vector2(-1f, 0f),
                    trough + new Vector2(1f, 0f), trough + new Vector2(0f, -1f),
                };
                Vector2? standingTile = standingCandidates
                    .Where(candidate => animalHouse.isTileOnMap(candidate)
                        && animalHouse.isTilePassable(candidate)
                        && !animalHouse.IsTileOccupiedBy(candidate, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
                    .Cast<Vector2?>()
                    .FirstOrDefault();
                if (standingTile is null)
                    throw new InvalidOperationException("fixture_native_feed_animal_trough_approach_missing");
                // The fixture SetupBigFarm call is already running on the
                // game-thread pre-attachment seam. Complete the exact native
                // Farm→AnimalHouse warp lifecycle now; this positions only the
                // local Player and does not interact with the Trough.
                player.warpFarmer(new StardewValley.Warp(
                    entryPoint.X,
                    entryPoint.Y,
                    animalHouse.NameOrUniqueName,
                    (int)standingTile.Value.X,
                    (int)standingTile.Value.Y,
                    false));
                // `warpFarmer` begins a native transition; retain the fixture
                // target facts and finish the local-player position only after
                // that transition has completed in a later game tick.
                this.nativeLocalFeedFixturePending = new NativeLocalFeedFixturePending(
                    animalHouse.NameOrUniqueName,
                    trough,
                    standingTile.Value);
                return;
            }

            if (fixture.FixtureScenario == "native_collect_animal_product_v1")
            {
                // SetupBigFarm is a target-version pre-attachment setup route
                // for an adult animal with a ready product. It does not invoke
                // either collection tool, clear product, add produce, or emit a
                // receipt; the typed production action remains the sole ingress.
                GameLocation? productSetupPreviousLocation = Game1.currentLocation;
                try
                {
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("SetupBigFarm", null))
                        throw new InvalidOperationException("fixture_native_collect_animal_product_setup_unavailable");
                }
                finally { Game1.currentLocation = productSetupPreviousLocation; }

                (StardewValley.AnimalHouse House, FarmAnimal Animal, Tool Tool, string ToolKind)? compatible = farm.buildings
                    .Select(building => building.GetIndoors())
                    .OfType<StardewValley.AnimalHouse>()
                    .SelectMany(house => house.animals.Values.Select(animal => (House: house, Animal: animal)))
                    .Where(candidate => candidate.Animal.isAdult() && candidate.Animal.currentProduce.Value is not null)
                    .Select(candidate => candidate.Animal.CanGetProduceWithTool(new MilkPail())
                        ? (candidate.House, candidate.Animal, Tool: (Tool)new MilkPail(), ToolKind: "milk_pail")
                        : candidate.Animal.CanGetProduceWithTool(new Shears())
                            ? (candidate.House, candidate.Animal, Tool: (Tool)new Shears(), ToolKind: "shears")
                            : ((StardewValley.AnimalHouse House, FarmAnimal Animal, Tool Tool, string ToolKind)?)null)
                    .FirstOrDefault(candidate => candidate is not null);
                if (compatible is null)
                    throw new InvalidOperationException("fixture_native_collect_animal_product_ready_animal_missing");
                Vector2? standingTile = new[]
                {
                    compatible.Value.Animal.Tile + new Vector2(0f, 1f), compatible.Value.Animal.Tile + new Vector2(-1f, 0f),
                    compatible.Value.Animal.Tile + new Vector2(1f, 0f), compatible.Value.Animal.Tile + new Vector2(0f, -1f),
                }.Where(tile => compatible.Value.House.isTileOnMap(tile) && compatible.Value.House.isTilePassable(tile)
                    && !compatible.Value.House.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
                    .Cast<Vector2?>().FirstOrDefault();
                if (standingTile is null)
                    throw new InvalidOperationException("fixture_native_collect_animal_product_approach_missing");
                if (!player.Items.OfType<Tool>().Any(tool => tool.GetType() == compatible.Value.Tool.GetType())
                    && player.addItemToInventory(compatible.Value.Tool) is not null)
                    throw new InvalidOperationException("fixture_native_collect_animal_product_tool_inventory_full");
                if (!player.Items.OfType<Tool>().Any(tool => tool.GetType() == compatible.Value.Tool.GetType()))
                    throw new InvalidOperationException("fixture_native_collect_animal_product_tool_missing_after_add");
                player.warpFarmer(new StardewValley.Warp(0, 0, compatible.Value.House.NameOrUniqueName,
                    (int)standingTile.Value.X, (int)standingTile.Value.Y, false));
                this.nativeLocalCollectAnimalProductFixturePending = new NativeLocalCollectAnimalProductFixturePending(
                    compatible.Value.House.NameOrUniqueName, compatible.Value.Animal.myID.Value, compatible.Value.Animal.Tile,
                    compatible.Value.Animal.currentProduce.Value, compatible.Value.ToolKind);
                return;
            }

            if (fixture.FixtureScenario == "native_refill_watering_can_v1")
            {
                // This fixture establishes only a single ordinary, partially
                // filled can and a disposable-working-save map precondition.
                // The pinned GameLocation predicate accepts a Back-layer
                // WaterSource property, so mark the local player's current
                // FarmHouse tile and verify that predicate before attachment.
                // This never invokes the watering can or creates a receipt.
                if (player.currentLocation is not StardewValley.Locations.FarmHouse farmHouse)
                    throw new InvalidOperationException("fixture_native_local_refill_farmhouse_missing");
                foreach (Item? ownedItem in player.Items.Where(item => item is WateringCan).ToArray())
                    player.Items.Remove(ownedItem);
                WateringCan suppliedCan = new();
                suppliedCan.WaterLeft = Math.Max(1, suppliedCan.waterCanMax - 1);
                if (player.addItemToInventory(suppliedCan) is not null || player.Items.OfType<WateringCan>().Count() != 1)
                    throw new InvalidOperationException("fixture_native_local_refill_watering_can_missing_or_ambiguous");
                Point sourceTile = player.TilePoint;
                xTile.Layers.Layer? backLayer = farmHouse.map.GetLayer("Back");
                if (backLayer is null || sourceTile.X < 0 || sourceTile.Y < 0 || sourceTile.X >= backLayer.LayerWidth || sourceTile.Y >= backLayer.LayerHeight || backLayer.Tiles[sourceTile.X, sourceTile.Y] is null)
                    throw new InvalidOperationException("fixture_native_local_refill_source_tile_unavailable");
                backLayer.Tiles[sourceTile.X, sourceTile.Y].Properties["WaterSource"] = "GameBuddyNativeLocalFixture";
                if (!string.Equals(farmHouse.doesTileHaveProperty(sourceTile.X, sourceTile.Y, "WaterSource", "Back"), "GameBuddyNativeLocalFixture", StringComparison.Ordinal)
                    || !farmHouse.CanRefillWateringCanOnTile(sourceTile.X, sourceTile.Y))
                    throw new InvalidOperationException("fixture_native_local_refill_source_creation_failed");
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized refill-watering-can precondition before bridge attachment: water={suppliedCan.WaterLeft}; max={suppliedCan.waterCanMax}; fixture_farmhouse_water_source={sourceTile.X},{sourceTile.Y}; production alone refills and emits receipt.", LogLevel.Info);
                return;
            }

            if (fixture.FixtureScenario != "native_water_crop_v1")
                throw new InvalidOperationException("fixture_native_local_scenario_dispatch_invalid");

            WateringCan? availableCan = player.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
            if (availableCan is null)
            {
                WateringCan suppliedCan = new();
                if (player.addItemToInventory(suppliedCan) is not null)
                    throw new InvalidOperationException("fixture_native_local_watering_can_inventory_full");
                availableCan = player.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
            }
            if (availableCan is null)
                throw new InvalidOperationException("fixture_native_local_watering_can_missing_after_add");
            GameLocation? cropSetupPreviousLocation = Game1.currentLocation;
            try
            {
                Game1.currentLocation = farm;
                // Target-version SpreadSeeds populates only existing HoeDirt.
                // The event-free native-local template starts without dirt, so
                // establish empty native dirt before spreading the dry crop.
                if (!Game1.game1.parseDebugInput("SpreadDirt", null))
                    throw new InvalidOperationException("fixture_native_spread_dirt_command_unavailable");
                if (!Game1.game1.parseDebugInput("SpreadSeeds 472", null))
                    throw new InvalidOperationException("fixture_native_spread_seeds_command_unavailable");
            }
            finally { Game1.currentLocation = cropSetupPreviousLocation; }
            int dryCropCount = farm.terrainFeatures.Pairs.Count(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null } dirt
                && dirt.needsWatering() && !dirt.isWatered());
            if (dryCropCount == 0)
                throw new InvalidOperationException("fixture_native_local_unwatered_crop_missing");
            this.nativeLocalPlayerFixtureInitialized = true;
            this.Monitor.Log($"GameBuddy native-local-player initialized native water-crop fixture before bridge attachment: watering_can_water={availableCan.WaterLeft}; unwatered_crop_count={dryCropCount}; production alone waters and emits receipt.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log($"GameBuddy native-local-player fixture setup failed: scenario={fixture.FixtureScenario}; error={DescribeNativeLocalFixtureSetupFailure(exception)}; exception_type={exception.GetType().Name}.", LogLevel.Error);
        }
    }

    private void InitializeNativeLocalNpcRelationshipFixture(Farmer player, Farm farm)
    {
        // `npc_relationship` only reads a relationship record. The disposable
        // fixture therefore establishes the persisted fact and moves one
        // target-version villager using the native warp lifecycle; it never
        // calls the bridge ingress or changes any of the reported facts after
        // their construction.
        const string npcName = "Robin";
        StardewValley.NPC? npc = Utility.getAllCharacters().FirstOrDefault(candidate => candidate.IsVillager && string.Equals(candidate.Name, npcName, StringComparison.Ordinal));
        if (npc is null)
            throw new InvalidOperationException("fixture_native_local_npc_relationship_npc_missing");
        if (!player.friendshipData.TryGetValue(npcName, out Friendship? relationship))
        {
            relationship = new Friendship();
            player.friendshipData[npcName] = relationship;
        }
        // This is an explicit fixture fact, not an NPC interaction. Reset the
        // disposable record through Friendship's target-version domain API,
        // then establish the read-only inspection baseline before attachment.
        relationship.Clear();
        relationship.Points = 250;
        if (relationship.Points != 250 || relationship.TalkedToToday || relationship.GiftsToday != 0 || relationship.GiftsThisWeek != 0)
            throw new InvalidOperationException("fixture_native_local_npc_relationship_fact_invalid");
        if (player.currentLocation is not StardewValley.Locations.FarmHouse farmHouse)
            throw new InvalidOperationException("fixture_native_local_npc_relationship_farmhouse_missing");
        StardewValley.Warp? farmWarp = farmHouse.warps.FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.NameOrUniqueName, StringComparison.Ordinal));
        if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
            throw new InvalidOperationException("fixture_native_local_npc_relationship_farm_warp_missing");
        // Give the production travel action a bounded but map-derived target:
        // select the first legal tile inside its published six-tile discovery
        // radius, never an arbitrary Town/schedule coordinate.
        Vector2? targetTile = FindNativeLocalFarmFixtureTile(farm, new Vector2(farmWarp.TargetX, farmWarp.TargetY), 6, requireEmptyObjectTile: true);
        if (targetTile is null)
            throw new InvalidOperationException("fixture_native_local_npc_relationship_placement_missing");
        Game1.warpCharacter(npc, farm, targetTile.Value);
        if (npc.currentLocation != farm || npc.Tile != targetTile.Value || !player.friendshipData.TryGetValue(npcName, out Friendship? actual) || actual.Points != 250 || actual.TalkedToToday || actual.GiftsToday != 0 || actual.GiftsThisWeek != 0)
            throw new InvalidOperationException("fixture_native_local_npc_relationship_placement_validation_failed");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized NPC-relationship precondition before bridge attachment: npc={npcName}; tile={(int)targetTile.Value.X},{(int)targetTile.Value.Y}; points={actual.Points}; talked_to_today=false; gifts_today=0; gifts_this_week=0; production alone inspects and emits receipt.", LogLevel.Info);
    }

    private void InitializeNativeLocalPetFixture(Farmer player, Farm farm)
    {
        // Pet is a player-visible precondition explicitly permitted by the
        // fixture SOP. Use the target-version constructor and normal location
        // registration only; do not call checkAction or manufacture a result.
        GameLocation location = player.currentLocation ?? throw new InvalidOperationException("fixture_native_local_pet_location_missing");
        Vector2? targetTile = FindNativeLocalFarmFixtureTile(location, player.Tile, 2, requireEmptyObjectTile: true);
        if (targetTile is null)
            throw new InvalidOperationException("fixture_native_local_pet_placement_missing");
        // Pet.checkAction requires empty hands. Clearing the current selected
        // inventory item is a legal pre-attachment starting condition, not an
        // invocation of the interaction or any of its result mutations.
        player.Items[player.CurrentToolIndex] = null;
        if (player.CurrentItem is not null)
            throw new InvalidOperationException("fixture_native_local_pet_hands_not_empty");
        StardewValley.Characters.Pet pet = new((int)targetTile.Value.X, (int)targetTile.Value.Y, "0", "Dog");
        pet.Name = "Dog";
        pet.homeLocationName.Value = farm.NameOrUniqueName;
        pet.grantedFriendshipForPet.Value = false;
        pet.friendshipTowardFarmer.Value = 0;
        location.addCharacter(pet);
        pet.currentLocation = location;
        // addCharacter owns the location registration. It may resolve ordinary
        // behavior/position on subsequent ticks, so validate only the
        // action-relevant native starting facts here; production rediscovery
        // binds the exact later coordinate and opaque target ID.
        if (!location.characters.Contains(pet) || pet.currentLocation != location || pet.petId.Value == Guid.Empty || pet.grantedFriendshipForPet.Value || pet.friendshipTowardFarmer.Value != 0 || pet.lastPetDay.TryGetValue(player.UniqueMultiplayerID, out int lastDay) && lastDay == Game1.Date.TotalDays)
            throw new InvalidOperationException("fixture_native_local_pet_placement_validation_failed");
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy native-local-player initialized pet-animal precondition before bridge attachment: pet_type={pet.petType.Value}; tile={(int)targetTile.Value.X},{(int)targetTile.Value.Y}; friendship=0; petted_today=false; friendship_callback=false; production alone invokes Pet.checkAction and emits receipt.", LogLevel.Info);
    }

    private static Vector2? FindNativeLocalArtifactSpotStandingTile(GameLocation farm, Vector2 artifactTile)
    {
        if (!farm.isTileOnMap(artifactTile)
            || farm.terrainFeatures.ContainsKey(artifactTile)
            || farm.GetHoeDirtAtTile(artifactTile) is not null
            || !farm.objects.TryGetValue(artifactTile, out StardewValley.Object? artifact)
            || artifact.QualifiedItemId != "(O)590"
            || artifact is StardewValley.Objects.IndoorPot)
            return null;
        return new[]
        {
            artifactTile + new Vector2(-1f, 0f), artifactTile + new Vector2(1f, 0f),
            artifactTile + new Vector2(0f, -1f), artifactTile + new Vector2(0f, 1f),
        }
        .Where(candidate => farm.isTileOnMap(candidate) && farm.isTilePassable(candidate)
            && !farm.IsTileOccupiedBy(candidate, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
        .Cast<Vector2?>()
        .FirstOrDefault();
    }

    private static bool IsExcludedCrabPotLocation(GameLocation location) =>
        location is StardewValley.Locations.Caldera or StardewValley.Locations.VolcanoDungeon or StardewValley.Locations.MineShaft;

    private static bool IsCrabPotFixtureInventoryUnchanged(Farmer player, NativeLocalPlaceCrabPotFixturePending pending)
    {
        if (player.Items.Count != pending.InventoryItems.Length)
            return false;
        for (int slot = 0; slot < pending.InventoryItems.Length; slot++)
        {
            Item? current = player.Items[slot];
            if (!ReferenceEquals(current, pending.InventoryItems[slot])
                || (current?.Stack ?? -1) != pending.InventoryStacks[slot]
                || current?.QualifiedItemId != pending.InventoryIds[slot])
                return false;
        }
        return true;
    }

    private static (Vector2 TargetTile, Vector2 StandingTile)? FindNativeLocalCrabPotFixtureTarget(GameLocation farm)
    {
        if (IsExcludedCrabPotLocation(farm))
            return null;
        int width = farm.map.Layers[0].LayerWidth;
        int height = farm.map.Layers[0].LayerHeight;
        foreach (Vector2 target in Enumerable.Range(0, width)
            .SelectMany(x => Enumerable.Range(0, height).Select(y => new Vector2(x, y))))
        {
            if (!farm.isTileOnMap(target)
                || !StardewValley.Objects.CrabPot.IsValidCrabPotLocationTile(farm, (int)target.X, (int)target.Y)
                || farm.objects.ContainsKey(target))
                continue;
            Vector2[] cardinal =
            {
                target + new Vector2(-1f, 0f), target + new Vector2(1f, 0f),
                target + new Vector2(0f, -1f), target + new Vector2(0f, 1f),
            };
            Vector2[] validStanding = cardinal
                .Where(standing => farm.isTileOnMap(standing)
                    && farm.isTilePassable(standing)
                    && !farm.IsTileOccupiedBy(standing, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
                .ToArray();
            if (validStanding.Length == 1)
                return (target, validStanding[0]);
        }
        return null;
    }

    private static Vector2? FindNativeLocalFarmFixtureTile(GameLocation location, Vector2 arrival, int radius, bool requireEmptyObjectTile, Func<Vector2, bool>? extraPredicate = null)
    {
        return Enumerable.Range(-radius, radius * 2 + 1)
            .SelectMany(offsetX => Enumerable.Range(-radius, radius * 2 + 1)
                .Select(offsetY => new Vector2(arrival.X + offsetX, arrival.Y + offsetY)))
            .Where(tile => tile != arrival && location.isTileOnMap(tile) && location.isTilePassable(tile)
                && (!requireEmptyObjectTile || !location.objects.ContainsKey(tile))
                && (extraPredicate is null || extraPredicate(tile))
                && !location.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: true))
            .Where(tile => new[] { tile + new Vector2(1f, 0f), tile + new Vector2(-1f, 0f), tile + new Vector2(0f, 1f), tile + new Vector2(0f, -1f) }
                .Any(approach => location.isTileOnMap(approach) && location.isTilePassable(approach)
                    && (Game1.player is not null && approach == Game1.player.Tile || !location.IsTileOccupiedBy(approach, CollisionMask.All, CollisionMask.None, useFarmerTile: true))))
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - arrival.X), Math.Abs(tile.Y - arrival.Y)))
            .ThenBy(tile => Math.Abs(tile.X - arrival.X) + Math.Abs(tile.Y - arrival.Y))
            .Cast<Vector2?>()
            .FirstOrDefault();
    }

    private static Vector2? FindNativeLocalFarmResourceClumpFixtureTile(GameLocation location, Vector2 arrival, int radius, int width, int height)
    {
        return Enumerable.Range(-radius, radius * 2 + 1)
            .SelectMany(offsetX => Enumerable.Range(-radius, radius * 2 + 1)
                .Select(offsetY => new Vector2(arrival.X + offsetX, arrival.Y + offsetY)))
            .Where(tile => tile != arrival && location.isTileOnMap(tile)
                && Enumerable.Range(0, width).SelectMany(footprintX => Enumerable.Range(0, height)
                    .Select(footprintY => new Vector2(tile.X + footprintX, tile.Y + footprintY)))
                    .All(footprint => location.CanItemBePlacedHere(footprint, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true)))
            .Where(tile => new[] { tile + new Vector2(1f, 0f), tile + new Vector2(-1f, 0f), tile + new Vector2(0f, 1f), tile + new Vector2(0f, -1f) }
                .Any(approach => location.isTileOnMap(approach) && location.isTilePassable(approach)
                    && (Game1.player is not null && approach == Game1.player.Tile || !location.IsTileOccupiedBy(approach, CollisionMask.All, CollisionMask.None, useFarmerTile: true))))
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - arrival.X), Math.Abs(tile.Y - arrival.Y)))
            .ThenBy(tile => Math.Abs(tile.X - arrival.X) + Math.Abs(tile.Y - arrival.Y))
            .Cast<Vector2?>()
            .FirstOrDefault();
    }

    private static string DescribeNativeLocalFixtureSetupFailure(Exception exception)
    {
        // Only our fixed diagnostic codes are safe to surface. Do not emit an
        // arbitrary native exception message into SMAPI logs.
        return exception is InvalidOperationException
            && exception.Message.StartsWith("fixture_native_", StringComparison.Ordinal)
            ? exception.Message
            : "unexpected_fixture_setup_exception";
    }

    private void LogNativeLocalPlayerReadinessIfBlocked()
    {
        if (Game1.player is null || (Game1.player.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp))
            return;
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - this.nativeLocalPlayerFixtureLastReadinessLogUnixMs < 1_000L)
            return;
        this.nativeLocalPlayerFixtureLastReadinessLogUnixMs = now;
        string state = Game1.activeClickableMenu is not null ? "menu_open" : Game1.eventUp ? "event_active" : !Game1.player.CanMove ? "player_cannot_move" : "unknown";
        this.Monitor.Log($"[DEBUG-native-local-readiness] state={state};location={Game1.player.currentLocation?.NameOrUniqueName ?? "unknown"};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};can_move={Game1.player.CanMove};event_up={Game1.eventUp};menu={Game1.activeClickableMenu?.GetType().Name ?? "none"}.", LogLevel.Trace);
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
        bool nativeLocalFixture = this.config.NativeLocalPlayerFixture?.Enable == true;
        bool formalClientConfigured = this.config.FarmhandProvisioner?.Enable == true;
        if (formalClientConfigured && (this.farmhandProvisioner is null || !this.farmhandProvisioner.IsReady))
            return;
        if (this.farmhandProvisioner is not null && !this.farmhandProvisioner.IsReady)
            return;
        ScreenEmbodimentState state = this.GetEmbodimentState();
        this.ClearState(state, "save_loaded");
        bool actorConfigured = nativeLocalFixture
            ? this.IsConfiguredNativeLocalPlayer(out Farmer? localPlayer, out string reason)
            : this.IsConfiguredAiScreen(out localPlayer, out reason);
        if (!actorConfigured)
        {
            this.Monitor.Log($"GameBuddy ignored local screen {Context.ScreenId}: {reason}.", LogLevel.Trace);
            return;
        }

        state.CapabilityPublication = FarmhandCapabilityPublication.Initial(this.config.EnabledActionSet);
        state.Executions = new ExecutionManager(this.Monitor, () => state.CapabilityPublication ?? throw new InvalidOperationException("Farmhand capability publication is unavailable."),
            receipt => this.PublishReceipt(state, receipt),
            trace => this.PublishBodyTrace(state, trace));
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
        FarmhandActionRouter router = CreateFarmhandActionRouter(state.Executions);

        string? launchGeneration = Environment.GetEnvironmentVariable(LaunchGenerationEnvironmentVariableName);
        BridgeRuntimeAttestation? runtimeAttestation = TryCreateRuntimeAttestation(
            formalClientConfigured,
            nativeLocalFixture,
            launchGeneration,
            out string? attestationReasonCode);
        if (runtimeAttestation is null)
            this.Monitor.Log($"GameBuddy bridge runtime attestation unavailable: {attestationReasonCode}.", LogLevel.Warn);

        state.BridgeSession = bridgeConfigValid && scopeMatchesWorld && runtimeAttestation is not null
            ? new BridgeSession(
                state.Executions,
                router,
                new BridgeScope("stardew", saveId, worldId, playerId, companionId),
                this.config.BridgeToken,
                () => state.CapabilityPublication ?? throw new InvalidOperationException("Farmhand capability publication is unavailable."),
                navigationSetProvider: () => DerivedDestinationSet.TryCreateCurrent("stardew", out DerivedDestinationSet? set, out _) ? set : null,
                runtimeAttestation: runtimeAttestation)
            : null;
        state.PlayerControlReplayGuard = state.BridgeSession is null ? null : new PlayerControlReplayGuard();
        state.LocalPipeBridge = state.BridgeSession is null ? null : new LocalPipeBridge(this.config.PipeName);
        state.LastPublishedCatalogRevision = state.CapabilityPublication.CapabilityRevision;
        if (!scopeMatchesWorld && formalClientConfigured)
            this.Monitor.Log("GameBuddy formal attachment remains closed: manifest and local save/world/Farmhand scope do not match.", LogLevel.Warn);
        else if (!scopeMatchesWorld && nativeLocalFixture)
            this.Monitor.Log("GameBuddy native-local-player fixture remains closed: configured save/world/local-player scope does not match the loaded native world.", LogLevel.Warn);
        if (this.config.EnableLocalBridge && state.BridgeSession is null)
            this.Monitor.Log(bridgeConfigValid
                ? "GameBuddy local bridge remains disabled: configured save/world scope does not bind to this AI Farmhand world."
                : "GameBuddy local bridge remains disabled: configuration must use opaque scope IDs and a 16+ character token.", LogLevel.Warn);
        else if (state.LocalPipeBridge is not null)
            this.Monitor.Log(nativeLocalFixture
                ? $"GameBuddy local named-pipe bridge started for native local Player screen {Context.ScreenId}."
                : $"GameBuddy local named-pipe bridge started for AI Farmhand screen {Context.ScreenId}.", LogLevel.Info);

        this.embodimentInitialized = true;
        this.Monitor.Log(nativeLocalFixture
            ? $"GameBuddy bound native local Player fixture: screen_id={Context.ScreenId}, player_id={localPlayer!.UniqueMultiplayerID}, location={localPlayer.currentLocation?.NameOrUniqueName ?? "unknown"}."
            : $"GameBuddy bound native AI Farmhand only: screen_id={Context.ScreenId}, farmhand_id={localPlayer!.UniqueMultiplayerID}, formal_attachment={this.farmhandProvisioner is not null}, location={localPlayer.currentLocation?.NameOrUniqueName ?? "unknown"}.",
            LogLevel.Info);
    }

    private static FarmhandActionRouter CreateFarmhandActionRouter(ExecutionManager executions)
    {
        ArgumentNullException.ThrowIfNull(executions);
        FarmingActionHandler farming = new(executions);
        GatheringActionHandler gathering = new(executions);
        MovementActionHandler movement = new(executions);
        MachineAndAnimalActionHandler machinesAndAnimals = new(executions);
        ResourceToolActionHandler resourceTools = new(executions);
        FarmhandActionRouter router = new();

        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Kind != FarmhandOperationKind.Execution)
                continue;
            IFarmhandActionHandler handler = registration.HandlerGroup switch
            {
                FarmhandActionHandlerGroup.Farming => farming,
                FarmhandActionHandlerGroup.Gathering => gathering,
                FarmhandActionHandlerGroup.Movement => movement,
                FarmhandActionHandlerGroup.MachinesAndAnimals => machinesAndAnimals,
                FarmhandActionHandlerGroup.ResourceTools => resourceTools,
                _ => throw new InvalidOperationException("Unknown Farmhand execution action handler group."),
            };
            router.Register(registration, handler);
        }

        return router;
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        // This gate must precede bootstrap, binding, producer, and bridge work;
        // rejected P0b configuration is fail-closed for the entire tick path.
        if (this.provisioningConfigurationRejected)
            return;
        if (this.config.Portfolio?.Bootstrap is { Enable: true })
        {
            this.TryBootstrapPortfolioNativeSave();
            if (!Context.IsWorldReady)
                return;
        }
        if (this.config.Portfolio?.InitialNativeLoad is { Enable: true })
        {
            this.TryLoadPortfolioInitialNativeSave();
            // An armed one-shot loader owns the only route into a Portfolio
            // binding. It disarms itself only from a matching SaveLoaded
            // completion; terminal rejection must never fall through to the
            // generic loaded-world branch on a later tick.
            return;
        }
        if (this.config.NativeLocalPlayerFixture?.Enable == true)
        {
            this.TryInitializeNativeLocalPlayerFixture();
            if (this.nativeLocalPlayerFixtureTerminal || !Context.IsWorldReady)
                return;
            if (!this.nativeLocalPlayerFixtureInitialized)
                return;
            this.TryInitializeEmbodiment();
            if (!this.IsConfiguredNativeLocalPlayer(out _, out _))
                return;
            this.LogNativeLocalPlayerReadinessIfBlocked();
            ScreenEmbodimentState nativeLocalState = this.GetEmbodimentState();
            this.RefreshFarmhandCapabilityPublication(nativeLocalState);
            this.ObserveBridgeGeneration(nativeLocalState);
            this.DrainLocalPipeBridge(nativeLocalState);
            nativeLocalState.Executions?.Update();
            this.PublishPendingStopObservation(nativeLocalState);
            return;
        }
        if (this.config.Portfolio?.Enable != true)
        {
            this.TryInitializeNativeFixtureScenario();
            this.TryStartHostAutomation();
            this.TryStartFarmhandProvisioner();
        }
        if (this.config.Portfolio?.Enable == true)
        {
            this.TryInitializePortfolioBinding();
            this.UpdatePortfolioP0bLifecycleProducer();
            this.UpdatePortfolioBridge();
            return;
        }
        this.hostFarmhandProvisioner?.Update();
        this.TryObserveNativeAutomationClientExit();
        this.TryTriggerNativeAutomationSave();
        this.TryInitializeNativeFixtureScenario();
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
        this.RefreshFarmhandCapabilityPublication(state);
        this.ObserveBridgeGeneration(state);
        this.ObserveNativeChatPipeDeliveries(state);
        this.ObserveTerminalReceiptDeliveries(state);
        this.DrainLocalPipeBridge(state);
        state.Executions?.Update();
        this.PublishPendingStopObservation(state);
    }

    private void TryStartHostAutomation()
    {
        HostAutomationConfig? automation = this.config.HostAutomation;
        if (!this.hostRoleConfigured || automation?.Enable != true || this.hostAutomationTerminal)
            return;

        // Stardew applies startup_preferences.languageCode asynchronously from
        // the title-menu update. Do not call SaveGame.Load before that native
        // initialization has reached the required live locale: a load first
        // locks the game into the fallback/default font for this whole run.
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!this.hostAutomationStarted && !NativeChatPresentationPolicy.IsFixtureLiveLocaleAvailable(
                automation.RequireFixtureLiveLocale,
                NativeChatPresentationPolicy.CurrentBcp47Locale()))
        {
            if (this.hostAutomationDeadlineUnixMs == 0)
                this.hostAutomationDeadlineUnixMs = now + Math.Clamp(automation.TimeoutSeconds, 10, 300) * 1_000L;
            if (now >= this.hostAutomationDeadlineUnixMs)
            {
                this.hostAutomationTerminal = true;
                this.PublishFixtureReadiness(automation, "fixture_blocked", "fixture_live_locale_unavailable");
                this.Monitor.Log("GameBuddy HostAutomation fixture blocked: required live locale was not applied at the native title menu.", LogLevel.Error);
            }
            return;
        }
        if (this.IsNativeAutomationWorldReady())
        {
            if (automation.FixtureScenario.Length > 0 && !this.hostAutomationFixtureInitialized)
                return;
            if (!NativeChatPresentationPolicy.IsFixtureLiveLocaleAvailable(automation.RequireFixtureLiveLocale, NativeChatPresentationPolicy.CurrentBcp47Locale()))
            {
                this.hostAutomationTerminal = true;
                this.PublishFixtureReadiness(automation, "fixture_blocked", "fixture_live_locale_unavailable");
                this.Monitor.Log("GameBuddy HostAutomation fixture blocked: required live locale is unavailable after native save load.", LogLevel.Error);
                return;
            }
            this.PublishFixtureReadiness(automation, "fixture_ready", "native_preconditions_ready");
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
        if (this.hostAutomationStarted)
        {
            if (now >= this.hostAutomationDeadlineUnixMs)
            {
                this.hostAutomationTerminal = true;
                this.PublishFixtureReadiness(automation, "fixture_blocked", "fixture_native_save_load_timeout");
                this.Monitor.Log($"GameBuddy HostAutomation fixture timed out while loading native save '{automation.SaveName}'.", LogLevel.Error);
            }
            return;
        }

        this.hostAutomationStarted = true;
        if (this.hostAutomationDeadlineUnixMs == 0)
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
            this.PublishFixtureReadiness(automation, "fixture_blocked", "fixture_native_save_load_failed");
            this.Monitor.Log($"GameBuddy HostAutomation failed to request native save load: {exception.GetType().Name}.", LogLevel.Error);
        }
    }

    /// <summary>
    /// Build a disposable native test world before the formal LAN lifecycle.
    /// The target-version debug helper owns building/animal setup; GameBuddy
    /// only fences scope and validates the resulting live facts. This method
    /// never enters a bridge request, calls the tested action, or emits a receipt.
    /// </summary>
    private void TryInitializeNativeFixtureScenario()
    {
        HostAutomationConfig? automation = this.config.HostAutomation;
        if (this.hostAutomationFixtureInitialized || this.hostAutomationTerminal || automation is not { Enable: true } || automation.FixtureScenario is not ("native_animal_product_v2" or "native_feed_animal_v1" or "native_water_crop_v1" or "native_fertilize_tile_v1" or "native_plant_seed_v1" or "native_till_soil_v1" or "native_machine_inspect_v1" or "native_npc_relationship_v1" or "native_pickup_forage_v1" or "native_pickup_item_v1" or "native_use_item_v1" or "native_harvest_crop_v1"))
            return;
        if (!automation.SaveName.StartsWith("GameBuddyFixture_", StringComparison.Ordinal) || !Context.IsWorldReady || !Game1.IsMasterGame || Game1.server is not null || this.hostFarmhandProvisioner?.IsAwaitingSave == true)
            return;

        try
        {
            Farm farm = Game1.getFarm();
            if (!farm.buildings.Any(building => building.GetIndoors() is StardewValley.Locations.Cabin))
                throw new InvalidOperationException("fixture_cabin_missing_before_native_setup");

            if (automation.FixtureScenario == "native_npc_relationship_v1")
            {
                this.InitializeNativeNpcRelationshipFixture(farm);
                return;
            }
            if (automation.FixtureScenario == "native_use_item_v1")
            {
                this.InitializeNativeUseItemFixture(farm);
                return;
            }

            // SetupBigFarm's target-version ClearFarm clears spawned/object
            // contents only; it retains existing buildings, including Cabin.
            // It uses native Build/AnimalHouse.adoptAnimal/door lifecycle.
            GameLocation? previousLocation = Game1.currentLocation;
            try
            {
                Game1.currentLocation = farm;
                bool invoked = Game1.game1.parseDebugInput("SetupBigFarm", null);
                if (!invoked)
                    throw new InvalidOperationException("fixture_native_debug_command_unavailable");
            }
            finally
            {
                Game1.currentLocation = previousLocation;
            }

            if (automation.FixtureScenario == "native_harvest_crop_v1")
            {
                // SetupBigFarm seeds 472..476, which are out of season in the
                // Summer template and are killed by the native GrowCrops pass.
                // Re-seed the same native crop plot with in-season Tomato
                // Seeds, then let the target-version GrowCrops command advance
                // the crop to its ready phase. This is fixture setup only: it
                // never calls HoeDirt.performUseAction or Crop.harvest.
                GameLocation? previousHarvestLocation = Game1.currentLocation;
                try
                {
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("SpreadSeeds 480", null)
                        || !Game1.game1.parseDebugInput("GrowCrops 11", null))
                        throw new InvalidOperationException("fixture_native_crop_setup_unavailable");
                }
                finally
                {
                    Game1.currentLocation = previousHarvestLocation;
                }
            }

            StardewValley.AnimalHouse[] houses = farm.buildings
                .Select(building => building.GetIndoors())
                .OfType<StardewValley.AnimalHouse>()
                .ToArray();
            if (houses.Length == 0)
                throw new InvalidOperationException("fixture_native_animal_house_missing");
            if (!farm.buildings.Any(building => building.GetIndoors() is StardewValley.Locations.Cabin))
                throw new InvalidOperationException("fixture_cabin_missing_after_native_setup");
            // Do not mistake a ready product for a collectable target: the exact
            // target-version tool predicate must hold. Sheep wool, for example,
            // requires Shears rather than a MilkPail.
            if (automation.FixtureScenario == "native_pickup_forage_v1")
            {
                this.InitializeNativePickupForageFixture(farm);
                return;
            }
            if (automation.FixtureScenario == "native_pickup_item_v1")
            {
                this.InitializeNativePickupItemFixture(farm);
                return;
            }
            if (automation.FixtureScenario == "native_harvest_crop_v1")
            {
                this.InitializeNativeHarvestCropFixture(farm);
                return;
            }
            if (automation.FixtureScenario == "native_machine_inspect_v1")
            {
                // SetupBigFarm owns the original target-version construction and
                // native Object initialization. Select a machine it produced;
                // never call a machine interaction, load/collect path, or edit
                // held output/input/timers. Inspection will only reread this
                // state through the production bridge after attachment.
                // SetupBigFarm lays Kegs in the native 3..14 × 36..44 grid.
                // Choose a perimeter Keg whose adjacent outside grid tile is
                // demonstrably walkable, so fixture navigation never guesses
                // through a dense machine cluster.
                KeyValuePair<Vector2, StardewValley.Object> machinePair = farm.objects.Pairs
                    .Where(pair => pair.Value.QualifiedItemId == "(BC)12" && pair.Value.GetMachineData() is not null)
                    .OrderBy(pair => pair.Key.X)
                    .ThenBy(pair => pair.Key.Y)
                    .FirstOrDefault(pair => new[]
                    {
                        pair.Key + new Vector2(-1f, 0f),
                        pair.Key + new Vector2(1f, 0f),
                        pair.Key + new Vector2(0f, -1f),
                        pair.Key + new Vector2(0f, 1f)
                    }.Any(tile => farm.isTilePassable(tile)
                        && farm.CanItemBePlacedHere(tile, itemIsPassable: true, CollisionMask.All, CollisionMask.None)));
                if (machinePair.Value is null)
                    throw new InvalidOperationException("fixture_native_machine_missing");
                StardewValley.Object machine = machinePair.Value;
                if (machine.GetMachineData() is null)
                    throw new InvalidOperationException("fixture_native_machine_data_missing");
                Vector2[] approachTiles = new[]
                {
                    machinePair.Key + new Vector2(-1f, 0f),
                    machinePair.Key + new Vector2(1f, 0f),
                    machinePair.Key + new Vector2(0f, -1f),
                    machinePair.Key + new Vector2(0f, 1f)
                };
                Vector2[] validApproaches = approachTiles
                    .Where(tile => farm.isTilePassable(tile)
                        && farm.CanItemBePlacedHere(tile, itemIsPassable: true, CollisionMask.All, CollisionMask.None)
                        && (tile.X < 3f || tile.X > 14f || tile.Y < 36f || tile.Y > 44f))
                    .ToArray();
                if (validApproaches.Length == 0)
                    throw new InvalidOperationException("fixture_native_machine_approach_missing");
                Vector2 approach = validApproaches[0];
                this.hostAutomationFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy HostAutomation initialized native machine-inspect v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; machine={machine.QualifiedItemId}@{(int)machinePair.Key.X},{(int)machinePair.Key.Y}; approach={(int)approach.X},{(int)approach.Y}; ready={machine.readyForHarvest.Value}; minutes_until_ready={machine.MinutesUntilReady}; held={machine.heldObject.Value?.QualifiedItemId ?? "none"}; last_input={machine.lastInputItem.Value?.QualifiedItemId ?? "none"}; a native save/reload plus production bridge reread are still required.", LogLevel.Info);
                return;
            }
            if (automation.FixtureScenario == "native_till_soil_v1")
            {
                if (!long.TryParse(this.config.PlayerId, out long tillFarmhandId))
                    throw new InvalidOperationException("fixture_farmhand_id_invalid");
                Farmer? tillFarmhand = Game1.GetPlayer(tillFarmhandId, onlyOnline: false);
                bool tillFarmhandOwnsRetainedCabin = tillFarmhand is not null && farm.buildings
                    .Select(building => building.GetIndoors())
                    .OfType<StardewValley.Locations.Cabin>()
                    .Any(cabin => cabin.OwnerId == tillFarmhandId);
                if (!tillFarmhandOwnsRetainedCabin || tillFarmhand is null)
                    throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
                if (tillFarmhand.MaxItems < 36)
                    tillFarmhand.increaseBackpackSize(36 - tillFarmhand.MaxItems);
                if (!tillFarmhand.Items.OfType<Hoe>().Any()
                    && tillFarmhand.addItemToInventory(new Hoe()) is not null)
                    throw new InvalidOperationException("fixture_farmhand_hoe_inventory_full");
                if (!tillFarmhand.Items.OfType<Hoe>().Any())
                    throw new InvalidOperationException("fixture_farmhand_hoe_missing_after_add");

                // SetupBigFarm starts with terrain features in its crop plot.
                // Reuse target-version debug commands only to establish legal,
                // empty ground for a future Hoe hit; production alone invokes
                // Hoe.DoFunction and creates the target postcondition.
                GameLocation? tillSetupPreviousLocation = Game1.currentLocation;
                try
                {
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("RemoveDirt", null))
                        throw new InvalidOperationException("fixture_native_remove_dirt_command_unavailable");
                }
                finally
                {
                    Game1.currentLocation = tillSetupPreviousLocation;
                }
                Vector2[] eligibleSoil = Enumerable.Range(0, farm.map.Layers[0].LayerWidth)
                    .SelectMany(x => Enumerable.Range(0, farm.map.Layers[0].LayerHeight)
                        .Select(y => new Vector2(x, y)))
                    .Where(tile => farm.GetHoeDirtAtTile(tile) is null
                        && farm.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Diggable", "Back") is not null
                        && !farm.isWaterTile((int)tile.X, (int)tile.Y))
                    .Take(64)
                    .ToArray();
                if (eligibleSoil.Length == 0)
                    throw new InvalidOperationException("fixture_native_tillable_soil_missing");
                this.hostAutomationFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy HostAutomation initialized native till-soil v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={tillFarmhand.MaxItems}; hoe=true; eligible_soil_count={eligibleSoil.Length}; eligible_soil_tiles={string.Join("|", eligibleSoil.Take(16).Select(tile => $"{(int)tile.X},{(int)tile.Y}"))}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
                return;
            }
            if (automation.FixtureScenario == "native_plant_seed_v1")
            {
                if (!long.TryParse(this.config.PlayerId, out long seedFarmhandId))
                    throw new InvalidOperationException("fixture_farmhand_id_invalid");
                Farmer? seedFarmhand = Game1.GetPlayer(seedFarmhandId, onlyOnline: false);
                bool seedFarmhandOwnsRetainedCabin = seedFarmhand is not null && farm.buildings
                    .Select(building => building.GetIndoors())
                    .OfType<StardewValley.Locations.Cabin>()
                    .Any(cabin => cabin.OwnerId == seedFarmhandId);
                if (!seedFarmhandOwnsRetainedCabin || seedFarmhand is null)
                    throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
                if (seedFarmhand.MaxItems < 36)
                    seedFarmhand.increaseBackpackSize(36 - seedFarmhand.MaxItems);
                // The validated fixture template is in Summer; use a normal Summer
                // crop seed so target-version canPlantThisSeedHere remains an
                // actual production precondition rather than a forced fixture fact.
                const string seedId = "(O)479";
                bool hasSeed = seedFarmhand.Items.OfType<StardewValley.Object>()
                    .Any(item => item.QualifiedItemId == seedId && item.Stack > 0);
                if (!hasSeed && seedFarmhand.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(seedId, 2)) is not null)
                    throw new InvalidOperationException("fixture_farmhand_seed_inventory_full");
                if (!seedFarmhand.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == seedId && item.Stack > 0))
                    throw new InvalidOperationException("fixture_farmhand_seed_missing_after_add");
                // SetupBigFarm creates grown crops. The target-version debug
                // commands remove only fixture HoeDirt and repopulate legal,
                // empty native ground dirt; they never create a crop or invoke
                // Object.placementAction, so production alone owns crop creation.
                GameLocation? seedSetupPreviousLocation = Game1.currentLocation;
                try
                {
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("RemoveDirt", null) || !Game1.game1.parseDebugInput("SpreadDirt", null))
                        throw new InvalidOperationException("fixture_native_empty_dirt_command_unavailable");
                }
                finally
                {
                    Game1.currentLocation = seedSetupPreviousLocation;
                }
                Vector2[] eligibleDirt = farm.terrainFeatures.Pairs
                    .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                        && dirt.crop is null
                        && !(farm.objects.TryGetValue(pair.Key, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
                        && dirt.canPlantThisSeedHere(seedId[3..^1], isFertilizer: false))
                    .Select(pair => pair.Key)
                    .ToArray();
                if (eligibleDirt.Length == 0)
                    throw new InvalidOperationException("fixture_native_seed_target_missing");
                this.hostAutomationFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy HostAutomation initialized native plant-seed v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={seedFarmhand.MaxItems}; seed={seedId}; eligible_empty_dirt_count={eligibleDirt.Length}; eligible_empty_dirt_tiles={string.Join("|", eligibleDirt.Take(16).Select(tile => $"{(int)tile.X},{(int)tile.Y}"))}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
                return;
            }
            if (automation.FixtureScenario == "native_water_crop_v1")
            {
                if (!long.TryParse(this.config.PlayerId, out long waterFarmhandId))
                    throw new InvalidOperationException("fixture_farmhand_id_invalid");
                Farmer? waterFarmhand = Game1.GetPlayer(waterFarmhandId, onlyOnline: false);
                bool waterFarmhandOwnsRetainedCabin = waterFarmhand is not null && farm.buildings
                    .Select(building => building.GetIndoors())
                    .OfType<StardewValley.Locations.Cabin>()
                    .Any(cabin => cabin.OwnerId == waterFarmhandId);
                if (!waterFarmhandOwnsRetainedCabin || waterFarmhand is null)
                    throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
                if (waterFarmhand.MaxItems < 36)
                    waterFarmhand.increaseBackpackSize(36 - waterFarmhand.MaxItems);
                WateringCan? availableCan = waterFarmhand.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
                if (availableCan is null)
                {
                    WateringCan suppliedCan = new();
                    if (waterFarmhand.addItemToInventory(suppliedCan) is not null)
                        throw new InvalidOperationException("fixture_farmhand_watering_can_inventory_full");
                    availableCan = waterFarmhand.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
                }
                if (availableCan is null)
                    throw new InvalidOperationException("fixture_farmhand_watering_can_missing_after_add");
                // SetupBigFarm finishes ordinary crops with GrowCrops, and a
                // mature non-regrowing crop no longer needs water. Use the
                // target-version debug seed spreader only to establish a new
                // native, unwatered crop precondition; never invoke `Water` or
                // assign HoeDirt state directly.
                GameLocation? cropSetupPreviousLocation = Game1.currentLocation;
                try
                {
                    Game1.currentLocation = farm;
                    if (!Game1.game1.parseDebugInput("SpreadSeeds 472", null))
                        throw new InvalidOperationException("fixture_native_spread_seeds_command_unavailable");
                }
                finally
                {
                    Game1.currentLocation = cropSetupPreviousLocation;
                }
                int dryCropCount = farm.terrainFeatures.Pairs.Count(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null } dirt
                    && dirt.needsWatering() && !dirt.isWatered());
                if (dryCropCount == 0)
                    throw new InvalidOperationException("fixture_native_unwatered_crop_missing");
                this.hostAutomationFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy HostAutomation initialized native water-crop v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={waterFarmhand.MaxItems}; watering_can_water={availableCan.WaterLeft}; unwatered_crop_count={dryCropCount}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
                return;
            }
            if (automation.FixtureScenario == "native_fertilize_tile_v1")
            {
                if (!long.TryParse(this.config.PlayerId, out long fertilizerFarmhandId))
                    throw new InvalidOperationException("fixture_farmhand_id_invalid");
                Farmer? fertilizerFarmhand = Game1.GetPlayer(fertilizerFarmhandId, onlyOnline: false);
                bool fertilizerFarmhandOwnsRetainedCabin = fertilizerFarmhand is not null && farm.buildings
                    .Select(building => building.GetIndoors())
                    .OfType<StardewValley.Locations.Cabin>()
                    .Any(cabin => cabin.OwnerId == fertilizerFarmhandId);
                if (!fertilizerFarmhandOwnsRetainedCabin || fertilizerFarmhand is null)
                    throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
                if (fertilizerFarmhand.MaxItems < 36)
                    fertilizerFarmhand.increaseBackpackSize(36 - fertilizerFarmhand.MaxItems);
                const string fertilizerId = "(O)368";
                bool hasFertilizer = fertilizerFarmhand.Items.OfType<StardewValley.Object>()
                    .Any(item => item.QualifiedItemId == fertilizerId && item.Stack > 0);
                if (!hasFertilizer && fertilizerFarmhand.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(fertilizerId, 2)) is not null)
                    throw new InvalidOperationException("fixture_farmhand_fertilizer_inventory_full");
                bool hasFertilizerAfter = fertilizerFarmhand.Items.OfType<StardewValley.Object>()
                    .Any(item => item.QualifiedItemId == fertilizerId && item.Stack > 0);
                if (!hasFertilizerAfter)
                    throw new InvalidOperationException("fixture_farmhand_fertilizer_missing_after_add");
                Microsoft.Xna.Framework.Vector2[] eligibleDirt = farm.terrainFeatures.Pairs
                    .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt && dirt.CanApplyFertilizer(fertilizerId))
                    .Select(pair => pair.Key)
                    .ToArray();
                string[] eligibleDirtTiles = eligibleDirt
                    .Take(16)
                    .Select(tile => $"{(int)tile.X},{(int)tile.Y}")
                    .ToArray();
                if (eligibleDirt.Length == 0)
                    throw new InvalidOperationException("fixture_native_fertilizer_target_missing");
                this.hostAutomationFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy HostAutomation initialized native fertilize-tile v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={fertilizerFarmhand.MaxItems}; fertilizer={fertilizerId}; eligible_dirt_count={eligibleDirt.Length}; eligible_dirt_tiles={string.Join("|", eligibleDirtTiles)}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
                return;
            }
            if (automation.FixtureScenario == "native_feed_animal_v1")
            {
                if (!long.TryParse(this.config.PlayerId, out long feedFarmhandId))
                    throw new InvalidOperationException("fixture_farmhand_id_invalid");
                Farmer? feedFarmhand = Game1.GetPlayer(feedFarmhandId, onlyOnline: false);
                bool feedFarmhandOwnsRetainedCabin = feedFarmhand is not null && farm.buildings
                    .Select(building => building.GetIndoors())
                    .OfType<StardewValley.Locations.Cabin>()
                    .Any(cabin => cabin.OwnerId == feedFarmhandId);
                if (!feedFarmhandOwnsRetainedCabin || feedFarmhand is null)
                    throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
                if (feedFarmhand.MaxItems < 36)
                    feedFarmhand.increaseBackpackSize(36 - feedFarmhand.MaxItems);
                bool hasHay = feedFarmhand.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == "(O)178" && item.Stack > 0);
                if (!hasHay && feedFarmhand.addItemToInventory(ItemRegistry.Create<StardewValley.Object>("(O)178", 2)) is not null)
                    throw new InvalidOperationException("fixture_farmhand_hay_inventory_full");
                bool hasHayAfter = feedFarmhand.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == "(O)178" && item.Stack > 0);
                if (!hasHayAfter)
                    throw new InvalidOperationException("fixture_farmhand_hay_missing_after_add");
                string feedInventory = string.Join(",", feedFarmhand.Items.Select((item, slot) => item is null ? $"{slot}:null" : $"{slot}:{item.QualifiedItemId}:stack={item.Stack}"));
                this.hostAutomationFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy HostAutomation initialized native feed-animal v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={feedFarmhand.MaxItems}; hay={hasHayAfter}; inventory={feedInventory}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
                return;
            }

            (FarmAnimal Animal, Tool Tool, string ToolKind)? compatible = houses
                .SelectMany(house => house.animals.Values)
                .Where(animal => animal.isAdult() && !string.IsNullOrWhiteSpace(animal.currentProduce.Value))
                .Select(animal => animal.CanGetProduceWithTool(new MilkPail())
                    ? (Animal: animal, Tool: (Tool)new MilkPail(), ToolKind: "MilkPail")
                    : animal.CanGetProduceWithTool(new Shears())
                        ? (Animal: animal, Tool: (Tool)new Shears(), ToolKind: "Shears")
                        : ((FarmAnimal Animal, Tool Tool, string ToolKind)?)null)
                .FirstOrDefault(candidate => candidate is not null);
            if (compatible is null)
                throw new InvalidOperationException("fixture_native_compatible_ready_animal_missing");

            // The debug helper equips only the Host. For this disposable fixture,
            // establish the *already bound* Farmhand's starting inventory using
            // the same target-version Farmer inventory API. Never infer an ID:
            // it must match a retained Cabin owner before LAN/attachment begins.
            if (!long.TryParse(this.config.PlayerId, out long configuredFarmhandId))
                throw new InvalidOperationException("fixture_farmhand_id_invalid");
            Farmer? farmhand = Game1.GetPlayer(configuredFarmhandId, onlyOnline: false);
            bool ownsRetainedCabin = farmhand is not null && farm.buildings
                .Select(building => building.GetIndoors())
                .OfType<StardewValley.Locations.Cabin>()
                .Any(cabin => cabin.OwnerId == configuredFarmhandId);
            if (!ownsRetainedCabin || farmhand is null)
                throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
            if (farmhand.MaxItems < 36)
                farmhand.increaseBackpackSize(36 - farmhand.MaxItems);
            bool hasCompatibleTool = compatible.Value.Tool is MilkPail
                ? farmhand.Items.OfType<MilkPail>().Any()
                : farmhand.Items.OfType<Shears>().Any();
            // addItemToInventoryBool intentionally refuses non-local Farmers.
            // Use the target-version inventory mutation API which applies its
            // normal MaxItems/empty-slot/stack rules to this offline Farmhand.
            if (!hasCompatibleTool && farmhand.addItemToInventory(compatible.Value.Tool) is not null)
                throw new InvalidOperationException("fixture_farmhand_tool_inventory_full");
            bool hasCompatibleToolAfter = compatible.Value.Tool is MilkPail
                ? farmhand.Items.OfType<MilkPail>().Any()
                : farmhand.Items.OfType<Shears>().Any();
            if (!hasCompatibleToolAfter)
                throw new InvalidOperationException("fixture_farmhand_compatible_tool_missing_after_add");

            this.hostAutomationFixtureInitialized = true;
            string houseFacts = string.Join("|", houses.Select(house =>
            {
                string animals = string.Join(",", house.animals.Values.Select(animal => $"{animal.type.Value}@{(int)animal.Tile.X},{(int)animal.Tile.Y}:adult={animal.isAdult()}:produce={animal.currentProduce.Value ?? "none"}:milkable={animal.CanGetProduceWithTool(new MilkPail())}:shearable={animal.CanGetProduceWithTool(new Shears())}"));
                return $"{house.NameOrUniqueName}[{animals}]";
            }));
            this.Monitor.Log($"GameBuddy HostAutomation initialized native animal-product v2 fixture before attachment: animal_houses={houses.Length}; Cabin retained; selected={compatible.Value.Animal.type.Value}@{(int)compatible.Value.Animal.Tile.X},{(int)compatible.Value.Animal.Tile.Y}; tool={compatible.Value.ToolKind}; Farmhand inventory_slots={farmhand.MaxItems}; compatible_tool={hasCompatibleToolAfter}; houses={houseFacts}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.hostAutomationTerminal = true;
            this.PublishFixtureReadiness(automation, "fixture_blocked", FixtureFailureReason(exception));
            this.Monitor.Log($"GameBuddy HostAutomation fixture initializer failed closed: {exception}", LogLevel.Error);
        }
    }

    private void PublishFixtureReadiness(HostAutomationConfig automation, string state, string reasonCode)
    {
        if (this.hostAutomationFixtureReadinessPublished || automation.FixtureScenario.Length == 0)
            return;
        try
        {
            if (this.hostFarmhandProvisioner is null)
                throw new InvalidOperationException("fixture_readiness_provisioner_unavailable");
            this.hostAutomationFixtureReadinessPublished = this.hostFarmhandProvisioner.PublishFixtureReadiness(
                automation.FixtureScenario,
                automation.SaveName,
                state,
                reasonCode);
        }
        catch (Exception exception)
        {
            this.hostAutomationTerminal = true;
            this.Monitor.Log($"GameBuddy HostAutomation could not publish fixture readiness: {exception.GetType().Name}.", LogLevel.Error);
        }
    }

    private static string FixtureFailureReason(Exception exception)
    {
        string candidate = exception.Message.Split(':', 2)[0];
        return BridgeProtocol.IsReasonCode(candidate) && candidate.StartsWith("fixture_", StringComparison.Ordinal)
            ? candidate
            : "fixture_native_setup_failed";
    }

    private void InitializeNativeNpcRelationshipFixture(StardewValley.Farm farm)
    {
        if (!long.TryParse(this.config.PlayerId, out long farmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? farmhand = Game1.GetPlayer(farmhandId, onlyOnline: false);
        if (farmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing");
        if (!farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == farmhandId))
            throw new InvalidOperationException("fixture_bound_farmhand_cabin_missing");
        // Keep the NPC on the native Farm map near the FarmHouse/Cabin warp
        // arrival. A saved offline Farmhand can be inside a Cabin with
        // furniture immediately around its spawn tile, so using
        // farmhand.currentLocation as the fixture location is not a reliable
        // approach precondition. Resolve the exact target-version warp from
        // the retained Cabin instead of guessing a map coordinate.
        GameLocation targetLocation = farm;
        StardewValley.Warp? farmWarp = farmhand.currentLocation?.warps.FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        farmWarp ??= Game1.locations
            .OfType<StardewValley.Locations.Cabin>()
            .SelectMany(cabin => cabin.warps)
            .FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
            throw new InvalidOperationException("fixture_native_npc_relationship_farm_warp_missing");
        Microsoft.Xna.Framework.Vector2 farmArrival = new(farmWarp.TargetX, farmWarp.TargetY);

        StardewValley.NPC? fixtureNpc = null;
        Utility.ForEachVillager(npc =>
        {
            if (string.IsNullOrWhiteSpace(npc.Name) || !farmhand.friendshipData.ContainsKey(npc.Name))
                return true;
            fixtureNpc = npc;
            return false;
        });
        if (fixtureNpc is null)
            throw new InvalidOperationException("fixture_native_npc_relationship_fact_missing");

        // Keep the fixture NPC close enough to the native Farm warp arrival
        // that the production runner can reach it through published movement.
        // Search the full bounded square, not only four cardinal rays: the
        // Cabin/building collision map can block the ray while leaving a
        // diagonal tile reachable. Never fall back to a distant NPC; a missing
        // near-arrival tile is a fixture blocker, not permission to widen the
        // production relationship radius.
        Microsoft.Xna.Framework.Vector2? destination = null;
        const int maximumArrivalOffset = 4;
        IEnumerable<Microsoft.Xna.Framework.Vector2> candidateTiles = Enumerable.Range(-maximumArrivalOffset, maximumArrivalOffset * 2 + 1)
            .SelectMany(offsetX => Enumerable.Range(-maximumArrivalOffset, maximumArrivalOffset * 2 + 1)
                .Select(offsetY => new Microsoft.Xna.Framework.Vector2(farmArrival.X + offsetX, farmArrival.Y + offsetY)))
            .Where(tile => tile != farmArrival)
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - farmArrival.X), Math.Abs(tile.Y - farmArrival.Y)))
            .ThenBy(tile => Math.Abs(tile.X - farmArrival.X) + Math.Abs(tile.Y - farmArrival.Y));
        foreach (Microsoft.Xna.Framework.Vector2 tile in candidateTiles)
        {
            if (!targetLocation.isTilePassable(tile)
                || targetLocation.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: true))
                continue;
            bool hasApproach = new[]
            {
                tile + new Microsoft.Xna.Framework.Vector2(1f, 0f),
                tile + new Microsoft.Xna.Framework.Vector2(-1f, 0f),
                tile + new Microsoft.Xna.Framework.Vector2(0f, 1f),
                tile + new Microsoft.Xna.Framework.Vector2(0f, -1f),
            }.Any(approach => targetLocation.isTilePassable(approach)
                && !targetLocation.IsTileOccupiedBy(approach, CollisionMask.All, CollisionMask.None, useFarmerTile: true));
            if (hasApproach)
            {
                destination = tile;
                break;
            }
        }
        if (destination is null)
            throw new InvalidOperationException($"fixture_native_npc_relationship_approach_missing:location={targetLocation.NameOrUniqueName};arrival={(int)farmArrival.X},{(int)farmArrival.Y};max_offset={maximumArrivalOffset}");

        Game1.warpCharacter(fixtureNpc, targetLocation, destination.Value);
        if (fixtureNpc.currentLocation != targetLocation || Math.Abs((int)fixtureNpc.Tile.X - (int)farmArrival.X) > maximumArrivalOffset || Math.Abs((int)fixtureNpc.Tile.Y - (int)farmArrival.Y) > maximumArrivalOffset)
            throw new InvalidOperationException("fixture_native_npc_relationship_warp_postcondition_missing");

        this.hostAutomationFixtureInitialized = true;
        Friendship relationship = farmhand.friendshipData[fixtureNpc.Name];
        this.Monitor.Log($"GameBuddy HostAutomation initialized native NPC-relationship v1 fixture before attachment: farmhand={farmhandId}; npc={fixtureNpc.Name}; location={fixtureNpc.currentLocation?.NameOrUniqueName}; tile={(int)fixtureNpc.Tile.X},{(int)fixtureNpc.Tile.Y}; farm_arrival={(int)farmArrival.X},{(int)farmArrival.Y}; points={relationship.Points}; status={relationship.Status}; no relationship mutation; a native save/reload plus production bridge reread are still required.", LogLevel.Info);
    }

    private void InitializeNativeUseItemFixture(StardewValley.Farm farm)
    {
        if (!long.TryParse(this.config.PlayerId, out long farmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? farmhand = Game1.GetPlayer(farmhandId, onlyOnline: false);
        bool ownsRetainedCabin = farmhand is not null && farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == farmhandId);
        if (!ownsRetainedCabin || farmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing");
        if (farmhand.MaxItems < 36)
            farmhand.increaseBackpackSize(36 - farmhand.MaxItems);

        const string foodId = "(O)216";
        StardewValley.Object? food = farmhand.Items.OfType<StardewValley.Object>()
            .FirstOrDefault(item => item.QualifiedItemId == foodId && item.Stack > 0);
        if (food is null)
        {
            StardewValley.Object suppliedFood = ItemRegistry.Create<StardewValley.Object>(foodId, 3);
            if (farmhand.addItemToInventory(suppliedFood) is not null)
                throw new InvalidOperationException("fixture_farmhand_food_inventory_full");
            food = farmhand.Items.OfType<StardewValley.Object>()
                .FirstOrDefault(item => item.QualifiedItemId == foodId && item.Stack > 0);
        }
        if (food is null || food.Edibility == -300 || (Game1.objectData.TryGetValue(food.ItemId, out var objectData) && objectData.IsDrink))
            throw new InvalidOperationException("fixture_farmhand_food_missing_after_add");

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native use-item v1 fixture before attachment: Cabin retained; food={food.QualifiedItemId}; stack={food.Stack}; edibility={food.Edibility}; Farmhand inventory_slots={farmhand.MaxItems}; production Farmer.eatHeldObject plus animation and stack postconditions are still required.", LogLevel.Info);
    }

    private void InitializeNativeHarvestCropFixture(StardewValley.Farm farm)
    {
        if (!long.TryParse(this.config.PlayerId, out long farmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? farmhand = Game1.GetPlayer(farmhandId, onlyOnline: false);
        bool ownsRetainedCabin = farmhand is not null && farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == farmhandId);
        if (!ownsRetainedCabin || farmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing");
        if (farmhand.MaxItems < 36)
            farmhand.increaseBackpackSize(36 - farmhand.MaxItems);

        // SetupBigFarm has already used the target-version GrowCrops command.
        // Select only a ready ordinary Grab crop from its native crop plot; do
        // not call Crop.harvest, performUseAction, destroyCrop, or add harvest
        // output here. Production must independently rediscover this target.
        const int cropPlotAnchorX = 38;
        const int cropPlotAnchorY = 18;
        KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>? selected = farm.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                && !dirt.crop.forageCrop.Value
                && dirt.readyForHarvest()
                && dirt.crop.GetHarvestMethod() == StardewValley.GameData.Crops.HarvestMethod.Grab
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value))
            .Select(pair => new KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>(pair.Key, (StardewValley.TerrainFeatures.HoeDirt)pair.Value))
            .Where(pair => Math.Max(Math.Abs((int)pair.Key.X - cropPlotAnchorX), Math.Abs((int)pair.Key.Y - cropPlotAnchorY)) <= 1)
            .OrderBy(pair => Math.Max(Math.Abs((int)pair.Key.X - cropPlotAnchorX), Math.Abs((int)pair.Key.Y - cropPlotAnchorY)))
            .ThenBy(pair => pair.Key.X)
            .ThenBy(pair => pair.Key.Y)
            .Cast<KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>?>()
            .FirstOrDefault();
        if (selected is null || selected.Value.Value.crop is null)
            throw new InvalidOperationException("fixture_native_ready_grab_crop_missing");

        StardewValley.Crop crop = selected.Value.Value.crop;
        StardewValley.Item harvestItem;
        try
        {
            harvestItem = ItemRegistry.Create(crop.indexOfHarvest.Value, 1);
        }
        catch (Exception)
        {
            throw new InvalidOperationException("fixture_native_harvest_item_missing");
        }
        if (!farmhand.couldInventoryAcceptThisItem(harvestItem))
            throw new InvalidOperationException("fixture_farmhand_harvest_inventory_unavailable");

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native harvest-crop v1 fixture before attachment: Cabin retained; selected={crop.netSeedIndex.Value ?? "unknown"}@{(int)selected.Value.Key.X},{(int)selected.Value.Key.Y}; harvest={harvestItem.QualifiedItemId}; ready={selected.Value.Value.readyForHarvest()}; harvest_method={crop.GetHarvestMethod()}; regrows={crop.RegrowsAfterHarvest()}; Farmhand inventory_slots={farmhand.MaxItems}; production HoeDirt.performUseAction plus native inventory and crop postconditions are still required.", LogLevel.Info);
    }

    private void InitializeNativePickupForageFixture(StardewValley.Farm farm)
    {
        if (!long.TryParse(this.config.PlayerId, out long farmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? farmhand = Game1.GetPlayer(farmhandId, onlyOnline: false);
        if (farmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing");
        if (!farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == farmhandId))
            throw new InvalidOperationException("fixture_bound_farmhand_cabin_missing");

        // Resolve the target-version Farm arrival from the retained Cabin warp;
        // never hard-code a map coordinate or put the forage object outside the
        // map. The object is created only as an automation fixture precondition.
        StardewValley.Warp? farmWarp = farmhand.currentLocation?.warps.FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        farmWarp ??= Game1.locations
            .OfType<StardewValley.Locations.Cabin>()
            .SelectMany(cabin => cabin.warps)
            .FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
            throw new InvalidOperationException("fixture_native_pickup_forage_farm_warp_missing");
        Vector2 farmArrival = new(farmWarp.TargetX, farmWarp.TargetY);

        // Keep the target within the first discovery radius of the native warp
        // arrival, but require a separate passable approach tile. This makes a
        // missing legal placement a bounded fixture blocker rather than an
        // excuse to widen the production action's range.
        Vector2[] candidateTiles = Enumerable.Range(-1, 3)
            .SelectMany(offsetX => Enumerable.Range(-1, 3)
                .Select(offsetY => new Vector2(farmArrival.X + offsetX, farmArrival.Y + offsetY)))
            .Where(tile => tile != farmArrival
                && farm.isTileOnMap(tile)
                && farm.isTilePassable(tile)
                && !farm.objects.ContainsKey(tile)
                && farm.CanItemBePlacedHere(tile))
            .Where(tile => new[]
            {
                tile + new Vector2(1f, 0f),
                tile + new Vector2(-1f, 0f),
                tile + new Vector2(0f, 1f),
                tile + new Vector2(0f, -1f),
            }.Any(approach => farm.isTileOnMap(approach)
                && farm.isTilePassable(approach)
                && !farm.IsTileOccupiedBy(approach, CollisionMask.All, CollisionMask.None, useFarmerTile: true)))
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - farmArrival.X), Math.Abs(tile.Y - farmArrival.Y)))
            .ThenBy(tile => Math.Abs(tile.X - farmArrival.X) + Math.Abs(tile.Y - farmArrival.Y))
            .ToArray();
        if (candidateTiles.Length == 0)
            throw new InvalidOperationException($"fixture_native_pickup_forage_placement_missing:arrival={(int)farmArrival.X},{(int)farmArrival.Y}");

        // These are ordinary target-version forage objects. `dropObject` is
        // deliberately used instead of objects.Add: it applies the native map
        // placement checks and marks IsSpawnedObject, which is required by
        // GameLocation.checkAction's forage pickup branch. This remains
        // HostAutomation-only setup; the bridge never exposes object creation.
        string[] forageIds = new[] { "(O)399", "(O)396", "(O)398", "(O)16", "(O)18", "(O)20", "(O)22" };
        Vector2 placedTile = Vector2.Zero;
        StardewValley.Object? placedForage = null;
        foreach (Vector2 tile in candidateTiles)
        {
            foreach (string qualifiedItemId in forageIds)
            {
                StardewValley.Object forage = ItemRegistry.Create<StardewValley.Object>(qualifiedItemId, 1);
                if (!forage.isForage())
                    continue;
                if (!farm.dropObject(forage, tile * 64f, Game1.viewport, initialPlacement: true))
                    continue;
                if (farm.objects.TryGetValue(tile, out StardewValley.Object? actual)
                    && ReferenceEquals(actual, forage)
                    && actual.IsSpawnedObject
                    && actual.isForage())
                {
                    placedTile = tile;
                    placedForage = actual;
                    break;
                }
            }
            if (placedForage is not null)
                break;
        }
        if (placedForage is null)
            throw new InvalidOperationException("fixture_native_pickup_forage_object_placement_failed");

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native pickup-forage v1 fixture before attachment: Cabin retained; farm_arrival={(int)farmArrival.X},{(int)farmArrival.Y}; forage={placedForage.QualifiedItemId}; stack={placedForage.Stack}; tile={(int)placedTile.X},{(int)placedTile.Y}; spawned={placedForage.IsSpawnedObject}; native checkAction plus inventory/removal postconditions are still required.", LogLevel.Info);
    }

    private void InitializeNativePickupItemFixture(StardewValley.Farm farm)
    {
        if (!long.TryParse(this.config.PlayerId, out long farmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? farmhand = Game1.GetPlayer(farmhandId, onlyOnline: false);
        if (farmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing");
        if (!farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == farmhandId))
            throw new InvalidOperationException("fixture_bound_farmhand_cabin_missing");

        StardewValley.Warp? farmWarp = farmhand.currentLocation?.warps.FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        farmWarp ??= Game1.locations
            .OfType<StardewValley.Locations.Cabin>()
            .SelectMany(cabin => cabin.warps)
            .FirstOrDefault(warp => !warp.npcOnly.Value && string.Equals(warp.TargetName, farm.Name, StringComparison.Ordinal));
        if (farmWarp is null || farmWarp.TargetX < 0 || farmWarp.TargetY < 0)
            throw new InvalidOperationException("fixture_native_pickup_item_farm_warp_missing");
        Vector2 farmArrival = new(farmWarp.TargetX, farmWarp.TargetY);

        // Debris is a target-version network object and is intentionally not
        // written to the save payload. The HostAutomation initializer recreates
        // it after every native host restart, before the final attachment. The
        // production action only guides the Farmhand into native magnetic
        // range; Debris.updateChunks itself owns Debris.collect.
        Vector2 hostTile = Game1.player.currentLocation == farm ? Game1.player.Tile : farmArrival;
        Vector2[] candidateTiles = Enumerable.Range(-4, 9)
            .SelectMany(offsetX => Enumerable.Range(-4, 9)
                .Select(offsetY => new Vector2(farmArrival.X + offsetX, farmArrival.Y + offsetY)))
            .Where(tile => Math.Max(Math.Abs(tile.X - farmArrival.X), Math.Abs(tile.Y - farmArrival.Y)) == 4
                && Math.Max(Math.Abs(tile.X - hostTile.X), Math.Abs(tile.Y - hostTile.Y)) >= 4
                && farm.isTileOnMap(tile)
                && farm.isTilePassable(tile)
                && !farm.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: true))
            .Where(tile => new[]
            {
                tile + new Vector2(1f, 0f),
                tile + new Vector2(-1f, 0f),
                tile + new Vector2(0f, 1f),
                tile + new Vector2(0f, -1f),
            }.Any(approach => farm.isTileOnMap(approach)
                && farm.isTilePassable(approach)
                && !farm.IsTileOccupiedBy(approach, CollisionMask.All, CollisionMask.None, useFarmerTile: true)))
            .OrderBy(tile => tile.X)
            .ThenBy(tile => tile.Y)
            .ToArray();
        if (candidateTiles.Length == 0)
            throw new InvalidOperationException($"fixture_native_pickup_item_placement_missing:arrival={(int)farmArrival.X},{(int)farmArrival.Y}");

        const string qualifiedItemId = "(O)388";
        StardewValley.Object item = ItemRegistry.Create<StardewValley.Object>(qualifiedItemId, 1);
        if (!farmhand.couldInventoryAcceptThisItem(item))
            throw new InvalidOperationException("fixture_farmhand_pickup_item_inventory_full");

        Vector2 placedTile = candidateTiles[0];
        int beforeDebrisCount = farm.debris.Count;
        StardewValley.Debris placedDebris = Game1.createItemDebris(
            item,
            new Vector2(placedTile.X * 64f + 32f, placedTile.Y * 64f + 32f),
            2,
            farm,
            (int)(placedTile.Y * 64f + 32f));
        if (farm.debris.Count != beforeDebrisCount + 1
            || !farm.debris.Contains(placedDebris)
            || placedDebris.debrisType.Value != StardewValley.Debris.DebrisType.OBJECT
            || placedDebris.Chunks.Count == 0
            || placedDebris.item is null
            || !string.Equals(placedDebris.item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_pickup_item_debris_postcondition_missing");

        // Keep the disposable drop outside both the master and Farmhand's
        // initial magnetic radius. This native dropped-by grace period is only
        // a short handoff guard; it is not the action's success mechanism.
        placedDebris.DroppedByPlayerID.Value = farmhandId;

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native pickup-item v1 fixture before attachment: Cabin retained; farm_arrival={(int)farmArrival.X},{(int)farmArrival.Y}; item={qualifiedItemId}; stack={placedDebris.item.Stack}; tile={(int)placedTile.X},{(int)placedTile.Y}; debris_type={placedDebris.debrisType.Value}; chunks={placedDebris.Chunks.Count}; dropped_by={farmhandId}; production must guide the Farmhand into range and prove target-version automatic Debris.collect, chunk removal, and inventory delivery.", LogLevel.Info);
    }

    private static bool IsFixtureAdjacentToFarmer(StardewValley.NPC npc, Farmer farmer)
    {
        return npc.currentLocation == farmer.currentLocation
            && Math.Abs((int)npc.Tile.X - (int)farmer.Tile.X) <= 1
            && Math.Abs((int)npc.Tile.Y - (int)farmer.Tile.Y) <= 1;
    }

    private static bool IsFixtureAdjacentToPlayer(StardewValley.NPC npc)
    {
        return IsFixtureAdjacentToFarmer(npc, Game1.player);
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
        // The internal Given fixture must settle before Portfolio binding can
        // open; action adapters still observe the same native lifecycle below.
        this.ObservePortfolioMineEntryGivenWarped(e);
        this.ObservePortfolioMineLadderGivenWarped(e);
        this.ObservePortfolioMineElevatorGivenWarped(e);
        // M8 consumes only the fresh native Player.Warped lifecycle callback;
        // the adapter and coordinator remain the sole owners of postcondition.
        this.portfolioMineElevatorAdapter?.ObserveWarped(e);
        this.portfolioMineEntryAdapter?.ObserveWarped(e);
        this.portfolioMineLadderAdapter?.ObserveWarped(e);
        if (this.nativeLocalBaitCrabPotFixturePending is NativeLocalBaitCrabPotFixturePending baitPending && e.Player == Game1.player)
        {
            if (e.NewLocation is Farm farm && string.Equals(farm.NameOrUniqueName, baitPending.FarmName, StringComparison.Ordinal)
                && e.Player.Tile == baitPending.StandingTile
                && farm.objects.TryGetValue(baitPending.TargetTile, out StardewValley.Object? placed)
                && ReferenceEquals(placed, baitPending.Pot) && baitPending.Pot.QualifiedItemId == "(O)710"
                && baitPending.Pot.owner.Value == baitPending.OwnerId && baitPending.Pot.bait.Value is null
                && e.Player.Items.Any(item => ReferenceEquals(item, baitPending.Bait) && item.QualifiedItemId == "(O)685" && item.Stack == 1))
            {
                this.nativeLocalBaitCrabPotFixturePending = null;
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized bait-crab-pot precondition before bridge attachment: pot={(int)baitPending.TargetTile.X},{(int)baitPending.TargetTile.Y}; bait=(O)685; production alone invokes GameLocation.checkAction probe+commit and emits receipt.", LogLevel.Info);
                return;
            }
            this.nativeLocalBaitCrabPotFixturePending = null;
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log("GameBuddy native-local-player fixture setup failed: scenario=native_bait_crab_pot_v1; error=fixture_native_local_bait_crab_pot_approach_unreachable; exception_type=InvalidOperationException.", LogLevel.Error);
            return;
        }
        if (this.nativeLocalPlaceCrabPotFixturePending is NativeLocalPlaceCrabPotFixturePending crabPotPending && e.Player == Game1.player)
        {
            if (e.NewLocation is Farm farm
                && string.Equals(farm.NameOrUniqueName, crabPotPending.FarmName, StringComparison.Ordinal)
                && !IsExcludedCrabPotLocation(farm)
                && StardewValley.Objects.CrabPot.IsValidCrabPotLocationTile(farm, (int)crabPotPending.TargetTile.X, (int)crabPotPending.TargetTile.Y)
                && farm.isTileOnMap(crabPotPending.StandingTile)
                && farm.isTilePassable(crabPotPending.StandingTile)
                && !farm.IsTileOccupiedBy(crabPotPending.StandingTile, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false)
                && e.Player.Items.Count(item => ReferenceEquals(item, crabPotPending.CrabPot)) == 1
                && crabPotPending.CrabPot.QualifiedItemId == "(O)710"
                && crabPotPending.CrabPot.Stack == crabPotPending.CrabPotStack
                && crabPotPending.CrabPot.Stack > 0
                && IsCrabPotFixtureInventoryUnchanged(e.Player, crabPotPending))
            {
                e.Player.Position = crabPotPending.StandingTile * Game1.tileSize;
                this.nativeLocalPlaceCrabPotFixturePending = null;
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized place-crab-pot precondition before bridge attachment: item=(O)710; target={(int)crabPotPending.TargetTile.X},{(int)crabPotPending.TargetTile.Y}; standing_tile={(int)crabPotPending.StandingTile.X},{(int)crabPotPending.StandingTile.Y}; production alone invokes CrabPot placement and emits receipt.", LogLevel.Info);
                return;
            }
            this.nativeLocalPlaceCrabPotFixturePending = null;
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log("GameBuddy native-local-player fixture setup failed: scenario=native_place_crab_pot_v1; error=fixture_native_local_crab_pot_approach_unreachable; exception_type=InvalidOperationException.", LogLevel.Error);
            return;
        }
        if (this.nativeLocalDigArtifactSpotFixturePending is NativeLocalDigArtifactSpotFixturePending artifactPending && e.Player == Game1.player)
        {
            if (e.NewLocation is Farm farm
                && string.Equals(farm.NameOrUniqueName, artifactPending.FarmName, StringComparison.Ordinal)
                && farm.objects.Pairs.Any(pair => pair.Value.QualifiedItemId == "(O)590")
                && farm.objects.TryGetValue(artifactPending.ArtifactTile, out StardewValley.Object? artifact)
                && artifact.QualifiedItemId == "(O)590"
                && farm.isTileOnMap(artifactPending.ArtifactTile)
                && farm.terrainFeatures.ContainsKey(artifactPending.ArtifactTile) == false
                && farm.GetHoeDirtAtTile(artifactPending.ArtifactTile) is null
                && artifact is not StardewValley.Objects.IndoorPot
                && farm.isTileOnMap(artifactPending.StandingTile)
                && farm.isTilePassable(artifactPending.StandingTile)
                && !farm.IsTileOccupiedBy(artifactPending.StandingTile, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false)
                && e.Player.Items.OfType<Hoe>().Count() == 1
                && e.Player.Items.OfType<Hoe>().Single().UpgradeLevel == 0)
            {
                e.Player.Position = artifactPending.StandingTile * Game1.tileSize;
                this.nativeLocalDigArtifactSpotFixturePending = null;
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized dig-artifact-spot precondition before bridge attachment: item=(O)590; tile={(int)artifactPending.ArtifactTile.X},{(int)artifactPending.ArtifactTile.Y}; standing_tile={(int)artifactPending.StandingTile.X},{(int)artifactPending.StandingTile.Y}; production alone performs the native hoe interaction and emits source-only receipt.", LogLevel.Info);
                return;
            }
            Farm? diagnosticFarm = e.NewLocation as Farm;
            StardewValley.Object? diagnosticArtifact = diagnosticFarm is not null
                && diagnosticFarm.objects.TryGetValue(artifactPending.ArtifactTile, out StardewValley.Object? artifactAtExpectedTile)
                ? artifactAtExpectedTile
                : null;
            int diagnosticHoeCount = e.Player.Items.OfType<Hoe>().Count();
            bool diagnosticBasicHoe = diagnosticHoeCount == 1
                && e.Player.Items.OfType<Hoe>().Single().UpgradeLevel == 0;
            this.Monitor.Log($"[DEBUG-artifact-fixture] player_is_game1_player={e.Player == Game1.player}; new_location_is_farm={diagnosticFarm is not null}; farm_name_equal={diagnosticFarm is not null && string.Equals(diagnosticFarm.NameOrUniqueName, artifactPending.FarmName, StringComparison.Ordinal)}; source_count={(diagnosticFarm?.objects.Pairs.Count(pair => pair.Value.QualifiedItemId == "(O)590") ?? 0)}; source_present_at_expected_tile={diagnosticArtifact is not null}; source_qid_is_590={diagnosticArtifact?.QualifiedItemId == "(O)590"}; source_on_map={diagnosticArtifact is not null && diagnosticFarm!.isTileOnMap(artifactPending.ArtifactTile)}; source_terrain_absent={diagnosticFarm is not null && !diagnosticFarm.terrainFeatures.ContainsKey(artifactPending.ArtifactTile)}; source_hoedirt_absent={diagnosticFarm is not null && diagnosticFarm.GetHoeDirtAtTile(artifactPending.ArtifactTile) is null}; source_indoor_pot={diagnosticArtifact is StardewValley.Objects.IndoorPot}; standing_on_map={diagnosticFarm is not null && diagnosticFarm.isTileOnMap(artifactPending.StandingTile)}; standing_passable={diagnosticFarm is not null && diagnosticFarm.isTilePassable(artifactPending.StandingTile)}; standing_occupied_use_farmer_tile_false={diagnosticFarm is not null && diagnosticFarm.IsTileOccupiedBy(artifactPending.StandingTile, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false)}; hoe_count={diagnosticHoeCount}; basic_hoe={diagnosticBasicHoe}; player_tile={(int)e.Player.Tile.X},{(int)e.Player.Tile.Y}; expected_standing_tile={(int)artifactPending.StandingTile.X},{(int)artifactPending.StandingTile.Y}.", LogLevel.Error);
            this.nativeLocalDigArtifactSpotFixturePending = null;
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log("GameBuddy native-local-player fixture setup failed: scenario=native_dig_artifact_spot_v1; error=fixture_native_local_artifact_spot_approach_unreachable; exception_type=InvalidOperationException.", LogLevel.Error);
            return;
        }
        if (this.nativeLocalClearHoeDirtFixturePending is NativeLocalClearHoeDirtFixturePending hoeDirtPending && e.Player == Game1.player)
        {
            if (e.NewLocation is Farm farm
                && string.Equals(farm.NameOrUniqueName, hoeDirtPending.FarmName, StringComparison.Ordinal)
                && farm.terrainFeatures.TryGetValue(hoeDirtPending.DirtTile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                && feature is StardewValley.TerrainFeatures.HoeDirt { crop: null }
                && farm.isTileOnMap(hoeDirtPending.StandingTile)
                // The just-warped Player now occupies this prevalidated tile;
                // do not reject the pending setup because of its own arrival.
                && farm.isTilePassable(hoeDirtPending.StandingTile))
            {
                e.Player.Position = hoeDirtPending.StandingTile * Game1.tileSize;
                this.nativeLocalClearHoeDirtFixturePending = null;
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized clear-hoedirt precondition before bridge attachment: tile={(int)hoeDirtPending.DirtTile.X},{(int)hoeDirtPending.DirtTile.Y}; standing_tile={(int)hoeDirtPending.StandingTile.X},{(int)hoeDirtPending.StandingTile.Y}; crop=none; indoor_pot=false. Production alone invokes exactly one Pickaxe hit and emits receipt.", LogLevel.Info);
                return;
            }
            this.nativeLocalClearHoeDirtFixturePending = null;
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log("GameBuddy native-local-player fixture setup failed: scenario=native_clear_hoedirt_v1; error=fixture_native_local_clear_hoedirt_approach_unreachable; exception_type=InvalidOperationException.", LogLevel.Error);
            return;
        }
        if (this.nativeLocalCollectAnimalProductFixturePending is NativeLocalCollectAnimalProductFixturePending productPending && e.Player == Game1.player)
        {
            if (e.NewLocation is StardewValley.AnimalHouse productHouse
                && string.Equals(productHouse.NameOrUniqueName, productPending.AnimalHouseName, StringComparison.Ordinal)
                && productHouse.animals.TryGetValue(productPending.AnimalId, out FarmAnimal? animal)
                && animal.isAdult() && animal.currentProduce.Value == productPending.ProduceId
                && e.Player.Items.OfType<Tool>().Any(tool => productPending.ToolKind == "milk_pail" ? tool is MilkPail : tool is Shears))
            {
                bool productInRange = Math.Abs((int)e.Player.Tile.X - (int)animal.Tile.X) <= 1
                    && Math.Abs((int)e.Player.Tile.Y - (int)animal.Tile.Y) <= 1;
                Vector2 productStandingTile = e.Player.Tile;
                bool approachAvailable = productInRange || TryFindNativeLocalAnimalProductApproach(productHouse, animal, out productStandingTile);
                if (approachAvailable)
                {
                    // The AnimalHouse may move an animal while rehydrating. This only
                    // establishes a freshly validated player position; no collection,
                    // output, inventory, tool-use, or receipt is produced by fixture setup.
                    if (!productInRange)
                        e.Player.Position = productStandingTile * Game1.tileSize;
                    this.nativeLocalCollectAnimalProductFixturePending = null;
                    this.nativeLocalPlayerFixtureInitialized = true;
                    this.Monitor.Log($"GameBuddy native-local-player initialized collect-animal-product precondition before bridge attachment: animal={animal.type.Value}; tile={(int)animal.Tile.X},{(int)animal.Tile.Y}; produce=(O){productPending.ProduceId}; tool={productPending.ToolKind}. Production alone invokes collection, clears product, adds inventory output, and emits receipt.", LogLevel.Info);
                    return;
                }
            }
            string productLocation = e.NewLocation?.NameOrUniqueName ?? "none";
            string productAnimal = e.NewLocation is StardewValley.AnimalHouse diagnosticHouse && diagnosticHouse.animals.TryGetValue(productPending.AnimalId, out FarmAnimal? diagnosticAnimal)
                ? $"type={diagnosticAnimal.type.Value};tile={(int)diagnosticAnimal.Tile.X},{(int)diagnosticAnimal.Tile.Y};adult={diagnosticAnimal.isAdult()};produce={diagnosticAnimal.currentProduce.Value ?? "none"}"
                : "missing";
            this.nativeLocalCollectAnimalProductFixturePending = null;
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log($"GameBuddy native-local-player fixture setup failed: scenario=native_collect_animal_product_v1; error=fixture_native_collect_animal_product_approach_unreachable; expected_house={productPending.AnimalHouseName}; new_location={productLocation}; expected_animal={productPending.AnimalId}; animal={productAnimal}; player={(int)e.Player.Tile.X},{(int)e.Player.Tile.Y}; expected_produce={productPending.ProduceId}; tool={productPending.ToolKind}; exception_type=InvalidOperationException.", LogLevel.Error);
            return;
        }
        if (this.nativeLocalFeedFixturePending is NativeLocalFeedFixturePending pending && e.Player == Game1.player)
        {
            if (e.NewLocation is StardewValley.AnimalHouse location
                && string.Equals(location.NameOrUniqueName, pending.AnimalHouseName, StringComparison.Ordinal)
                && Math.Abs((int)e.Player.Tile.X - (int)pending.TroughTile.X) <= 1
                && Math.Abs((int)e.Player.Tile.Y - (int)pending.TroughTile.Y) <= 1
                && location.doesTileHaveProperty((int)pending.TroughTile.X, (int)pending.TroughTile.Y, "Trough", "Back") is not null
                && !location.objects.ContainsKey(pending.TroughTile)
                && !e.Player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == "(O)178" && item.Stack > 0)
                && e.Player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>("(O)178", 2)) is null
                && e.Player.Items.OfType<StardewValley.Object>().Count(item => item.QualifiedItemId == "(O)178" && item.Stack == 2) == 1)
            {
                this.nativeLocalFeedFixturePending = null;
                this.nativeLocalPlayerFixtureInitialized = true;
                this.Monitor.Log($"GameBuddy native-local-player initialized feed-animal precondition before bridge attachment: animal_house={location.NameOrUniqueName}; trough={pending.TroughTile.X},{pending.TroughTile.Y}; standing_tile={e.Player.Tile.X},{e.Player.Tile.Y}; hay=2. Production alone performs native feed, consumes Hay, fills the trough, and emits receipt.", LogLevel.Info);
                return;
            }
            this.nativeLocalFeedFixturePending = null;
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log("GameBuddy native-local-player fixture setup failed: scenario=native_feed_animal_v1; error=fixture_native_feed_animal_trough_approach_unreachable; exception_type=InvalidOperationException.", LogLevel.Error);
            return;
        }
        if (this.TryGetAiState(out ScreenEmbodimentState state) && e.Player.UniqueMultiplayerID == Game1.player.UniqueMultiplayerID)
        {
            ExecutionManager executions = state.Executions!;
            NavigationWarpLifecycle.Settle(
                executions,
                e.Player == Game1.player,
                e.OldLocation?.NameOrUniqueName,
                e.NewLocation?.NameOrUniqueName,
                (int)e.Player.Tile.X,
                (int)e.Player.Tile.Y);
            this.PublishSemantic(state, "snapshot_changed", "warped");
        }

    }

    private void OnSaving(object? sender, SavingEventArgs e)
    {
        // P0b retains only its frozen initial scope across this invalidation.
        // It must never consult the live Portfolio binding during save lifecycle.
        this.InvalidatePortfolioState("portfolio_saving");
        this.ResetPortfolioMineLadderGivenFixture("saving");
        this.ResetPortfolioMineElevatorGivenFixture("saving");
        this.OnPortfolioP0bSaving();
        this.hostFarmhandProvisioner?.OnSaving();
        if (!this.TryGetAiState(out ScreenEmbodimentState state))
            return;
        ExecutionManager executions = state.Executions!;
        executions.InvalidateForLifecycle("saving");
        this.PublishLifecycle(state, "world_unavailable", "saving");
    }

    private void OnSaved(object? sender, SavedEventArgs e)
    {
        this.OnPortfolioP0bSaved();
        this.hostFarmhandProvisioner?.OnSaved();
        // A request can arrive while the previous native SaveGameMenu cycle is
        // still settling. Release the fixture latch at the authoritative Saved
        // edge so a newly pending attachment can request its own native save.
        this.hostAutomationSaveMenuOpened = false;
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
    {
        // P0b reload is authorized by its frozen initial scope and derived slot,
        // never by a binding that survived a title transition.
        this.InvalidatePortfolioState("portfolio_returned_to_title");
        this.ResetPortfolioMineLadderGivenFixture("returned_to_title");
        this.ResetPortfolioMineElevatorGivenFixture("returned_to_title");
        this.OnPortfolioP0bReturnedToTitle();
        this.hostFarmhandProvisioner?.OnReturnedToTitle();
        this.hostAutomationSaveMenuOpened = false;
        this.farmhandProvisioner?.Disconnect();
        this.farmhandProvisioner = null;
        this.nativeLocalPlayerFixtureStarted = false;
        this.nativeLocalPlayerFixtureInitialized = false;
        this.nativeLocalPlayerFixtureTerminal = false;
        this.nativeLocalPlayerFixtureDeadlineUnixMs = 0;
        this.nativeLocalPlayerFixtureLastReadinessLogUnixMs = 0;
        this.nativeLocalPlayerFixtureBootstrapInvoked = false;
        this.nativeLocalPlayerFixtureBootstrapTerminal = false;
        this.nativeLocalFeedFixturePending = null;
        this.nativeLocalCollectAnimalProductFixturePending = null;
        this.nativeLocalClearHoeDirtFixturePending = null;
        this.nativeLocalDigArtifactSpotFixturePending = null;
        this.nativeLocalPlaceCrabPotFixturePending = null;
        this.nativeLocalBaitCrabPotFixturePending = null;
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
        if (!this.RequireNativeLocalPlayerFixture(out ScreenEmbodimentState state))
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
        if (!this.RequireNativeLocalPlayerFixture(out ScreenEmbodimentState state))
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
        if (!this.RequireNativeLocalPlayerFixture(out ScreenEmbodimentState state))
            return;
        LocalExecutionReceipt receipt = state.Executions!.CancelActiveForFixture("local_console_cancel");
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    /// <summary>Game-thread only policy reload. It can only re-publish the fixed catalog's enabled subset.</summary>
    private void RefreshFarmhandCapabilityPublication(ScreenEmbodimentState state)
    {
        if (state.CapabilityPublication is null || state.BridgeSession is null || state.LocalPipeBridge is null)
            return;
        ModConfig refreshed;
        try { refreshed = this.Helper.ReadConfig<ModConfig>(); }
        catch (Exception exception)
        {
            this.Monitor.Log($"GameBuddy ignored unreadable Farmhand action policy reload: {exception.GetType().Name}.", LogLevel.Warn);
            return;
        }
        if (!refreshed.HasValidActionPolicy)
        {
            this.Monitor.Log("GameBuddy ignored invalid Farmhand action policy reload.", LogLevel.Warn);
            return;
        }
        FarmhandCapabilityPublication next = state.CapabilityPublication.WithEnabledActions(refreshed.EnabledActionSet);
        if (ReferenceEquals(next, state.CapabilityPublication))
            return;
        state.CapabilityPublication = next;
        long generation = state.LocalPipeBridge.CurrentGeneration;
        string correlationId = Guid.NewGuid().ToString("N");
        if (generation != 0 && state.BridgeSession.TryCreateCatalogUpdate(generation, state.LastPublishedCatalogRevision, correlationId, out string json)
            && state.LocalPipeBridge.TryEnqueueOutbound(generation, json))
            state.LastPublishedCatalogRevision = next.CapabilityRevision;
    }

    private void ObserveBridgeGeneration(ScreenEmbodimentState state)
    {
        if (state.LocalPipeBridge is null || state.Executions is null)
            return;

        if (state.LocalPipeBridge.TryConsumeWorkerTerminal(out PipeWorkerTerminal terminal))
            this.MonitorNativeChatIngress(terminal.Kind == PipeWorkerTerminalKind.ReaderEnded
                ? "ai_player_control_pipe_reader_ended"
                : "ai_player_control_pipe_writer_ended");

        long generation = state.LocalPipeBridge.CurrentGeneration;
        if (state.LastBridgeGeneration != 0 && generation == 0)
        {
            // A named-pipe disconnect is a local safety event. Do not wait for
            // the Host, model, TTS, or a reconnect before releasing movement.
            state.Executions.InvalidateForLifecycle("bridge_disconnected");
            this.Monitor.Log("GameBuddy invalidated the local execution because the bridge disconnected.", LogLevel.Warn);
        }
        state.LastBridgeGeneration = generation;
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
                string? requestType = typeElement.GetString();
                string? response = requestType switch
                {
                    "hello" => this.HandleHello(state, inbound.Generation, inbound.Json),
                    "observe_request" => this.HandleObserve(state, inbound.Generation, inbound.Json),
                    "navigation_read_request" => this.HandleNavigationRead(state, inbound.Generation, inbound.Json, correlationId),
                    "execution_request" => this.HandleExecute(state, inbound.Generation, inbound.Json),
                    "cancel_request" => this.HandleCancel(state, inbound.Generation, inbound.Json),
                    "execution_receipt_query" => this.HandleExecutionReceiptQuery(state, inbound.Generation, inbound.Json, correlationId),
                    "companion_presentation_request" => this.HandleCompanionPresentation(state, inbound.Generation, inbound.Json),
                    "system_notice_request" => this.HandleSystemNotice(state, inbound.Generation, inbound.Json),
                    "player_control_receipt" => this.HandlePlayerControlReceipt(state, inbound.Generation, inbound.Json, correlationId),
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
                this.Monitor.Log($"GameBuddy rejected local bridge request: {exception.GetType().Name}: {exception.Message}.", LogLevel.Warn);
            }
        }
    }

    /// <summary>
    /// Queue admission is not pipe delivery. Retain only the completion/generation
    /// for bounded redacted diagnosis; never retry or retain player content/IDs.
    /// </summary>
    private void TrackNativeChatPipeDelivery(ScreenEmbodimentState state, long generation, PipeOutboundCompletion completion)
    {
        if (state.NativeChatPipeDeliveries.Count >= 8)
        {
            this.MonitorNativeChatIngress("ai_player_control_pipe_delivery_untracked");
            return;
        }
        state.NativeChatPipeDeliveries.Enqueue(new NativeChatPipeDelivery(generation, completion, Environment.TickCount64));
    }

    private void ObserveNativeChatPipeDeliveries(ScreenEmbodimentState state)
    {
        while (state.NativeChatPipeDeliveries.TryPeek(out NativeChatPipeDelivery? pending))
        {
            if (pending.Completion.Result.IsCompleted)
            {
                state.NativeChatPipeDeliveries.Dequeue();
                this.MonitorNativeChatIngress(pending.Completion.Result.GetAwaiter().GetResult()
                    ? "ai_player_control_pipe_flushed"
                    : "ai_player_control_pipe_write_failed");
                continue;
            }
            if (Environment.TickCount64 - pending.EnqueuedAtMs >= 2_000)
            {
                state.NativeChatPipeDeliveries.Dequeue();
                this.MonitorNativeChatIngress("ai_player_control_pipe_flush_unconfirmed");
                continue;
            }
            break;
        }
    }

    private void PublishPendingStopObservation(ScreenEmbodimentState state)
    {
        BridgeStopObservation? observation = state.PendingStopObservation;
        if (observation is null || state.Executions is null || !state.Executions.IsBodySettled || state.LocalPipeBridge is null || state.BridgeSession is null)
            return;
        long generation = state.LocalPipeBridge.CurrentGeneration;
        string correlationId = Guid.NewGuid().ToString("N");
        if (generation != 0 && state.BridgeSession.TryCreateStopBodySettledEvent(generation, observation, correlationId, out string json)
            && state.LocalPipeBridge.TryEnqueueOutbound(generation, json))
            state.PendingStopObservation = null;
    }

    private void PublishReceipt(ScreenEmbodimentState state, LocalExecutionReceipt receipt)
    {
        if (state.LocalPipeBridge is null || state.BridgeSession is null)
            return;
        long generation = state.LocalPipeBridge.CurrentGeneration;
        if (generation != 0 && state.BridgeSession.TryCreateReceiptEvent(generation, receipt, out string json)
            && state.LocalPipeBridge.TryEnqueueOutbound(generation, json, out PipeOutboundCompletion completion))
        {
            // Queue admission is not pipe delivery. A terminal receipt must not
            // be silently claimed as delivered: its exact generation-bound
            // completion stays tracked until the bridge writer confirms the
            // flush (see ObserveTerminalReceiptDeliveries). Non-terminal receipt
            // events are observational and remain fire-and-forget.
            if (ModEntry.IsUnconfirmedTerminal(receipt.State)
                && !state.TerminalReceiptDeliveryTracker.TryTrack(receipt.RequestId, receipt.State, generation, completion, Environment.TickCount64))
            {
                // The bounded pending queue is full; fail closed: the receipt
                // can no longer be confirmed, so it is demoted to unconfirmed.
                this.MonitorNativeChatIngress("gamebuddy_terminal_receipt_delivery_untracked");
                state.TerminalReceiptDeliveryTracker.RetainUnconfirmed(receipt.RequestId, receipt.State, generation, Environment.TickCount64);
            }
            return;
        }
        // Terminal delivery failed (connection closed or outbound queue
        // saturated). Queue admission failure must never silently claim a
        // terminal receipt: retain a bounded, redacted unresolved diagnostic
        // for the exact request so the outcome stays recoverable (an exact
        // Host observe/idempotent replay can re-fetch the settled receipt)
        // and observably unconfirmed. Only requestId/state/generation/clock
        // are retained; they already exist in the exact execution ledger and
        // no player content or identity is added. Without a live connection
        // (generation 0) no peer can receive the frame; the settled receipt
        // stays in the execution ledger for an exact later observe.
        if (ModEntry.IsUnconfirmedTerminal(receipt.State) && generation != 0)
        {
            if (state.TerminalReceiptDeliveryTracker.RetainUnconfirmed(receipt.RequestId, receipt.State, generation, Environment.TickCount64))
                this.Monitor.Log($"GameBuddy terminal receipt for {receipt.RequestId} was not deliverable (closed/backpressured bridge); retained as an unconfirmed exact-receipt diagnostic.", LogLevel.Warn);
            else
                this.MonitorNativeChatIngress("gamebuddy_unconfirmed_terminal_receipt_untracked");
            return;
        }
        this.Monitor.Log("GameBuddy dropped a non-terminal receipt event due to closed/backpressured bridge.", LogLevel.Warn);
    }

    private void ObserveTerminalReceiptDeliveries(ScreenEmbodimentState state)
    {
        while (true)
        {
            TerminalReceiptDeliveryTracker.ObserveOutcome outcome = state.TerminalReceiptDeliveryTracker.Observe(Environment.TickCount64);
            if (outcome == TerminalReceiptDeliveryTracker.ObserveOutcome.Pending)
                return;
            this.MonitorNativeChatIngress(outcome switch
            {
                TerminalReceiptDeliveryTracker.ObserveOutcome.Flushed => "gamebuddy_terminal_receipt_flushed",
                TerminalReceiptDeliveryTracker.ObserveOutcome.WriteFailed => "gamebuddy_terminal_receipt_write_failed",
                _ => "gamebuddy_terminal_receipt_flush_unconfirmed",
            });
        }
    }

    // Unified with the wire/Host terminal-receipt classification
    // (host/src/execution-correlation-ledger.ts, gameplay-task-subagent.ts and
    // stardew-integration-launcher.ts classify blocked, invalidated, succeeded,
    // partially_succeeded, failed, cancelled, expired, rejected and uncertain as
    // terminal; accepted, running and meaningful_progress are progress states).
    internal static bool IsUnconfirmedTerminal(ExecutionState state) => state is
        ExecutionState.Succeeded or ExecutionState.PartiallySucceeded or ExecutionState.Failed
        or ExecutionState.Cancelled or ExecutionState.Invalidated or ExecutionState.Expired
        or ExecutionState.Rejected or ExecutionState.Blocked or ExecutionState.Uncertain;

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

    private void PublishBodyTrace(ScreenEmbodimentState state, ExecutionTrace trace)
    {
        if (state.LocalPipeBridge is null || state.BridgeSession is null)
            return;
        long generation = state.LocalPipeBridge.CurrentGeneration;
        string correlationId = Guid.NewGuid().ToString("N");
        if (generation != 0 && state.BridgeSession.TryCreateBodyTraceEvent(generation, trace, correlationId, out string json)
            && !state.LocalPipeBridge.TryEnqueueOutbound(generation, json))
            this.Monitor.Log("GameBuddy dropped body trace event due to closed/backpressured bridge.", LogLevel.Warn);
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

    private string? HandleHello(ScreenEmbodimentState state, long generation, string json)
    {
        string? response = this.SerializeBridgeResponse<BridgeHello, BridgeHelloAck>(state,
            BridgeProtocol.TryDeserializeInbound(json, "hello", out BridgeEnvelope<BridgeHello>? request, out _, "token") ? request : null,
            (BridgeEnvelope<BridgeHello> request, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string reason) => state.BridgeSession!.TryAuthenticate(generation, request, out acknowledgement, out reason), out _);
        // A successful hello_ack is this generation's complete catalog
        // publication, including a policy change that occurred while the pipe
        // was disconnected. Do not emit the same revision as catalog_update.
        if (response is not null)
        {
            state.LastPublishedCatalogRevision = state.BridgeSession!.CurrentCatalogRevision;
        }
        return response;
    }

    private string? HandleObserve(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeObserveRequest, BridgeSnapshot>(state,
        BridgeProtocol.TryDeserializeInbound(json, "observe_request", out BridgeEnvelope<BridgeObserveRequest>? request, out _) ? request : null,
        (BridgeEnvelope<BridgeObserveRequest> request, out BridgeEnvelope<BridgeSnapshot>? response, out string reason) => state.BridgeSession!.TryObserve(generation, request, out response, out reason), out _);

    private string? HandleNavigationRead(ScreenEmbodimentState state, long generation, string json, string? correlationId)
    {
        if (!BridgeProtocol.TryDeserializeNavigationReadRequest(json, out BridgeEnvelope<BridgeNavigationReadRequest>? request, out string parseReason) || request is null)
            return this.SerializeError(state, correlationId, parseReason);
        return this.SerializeBridgeResponse<BridgeNavigationReadRequest, BridgeNavigationReadResult>(state, request,
            (BridgeEnvelope<BridgeNavigationReadRequest> r, out BridgeEnvelope<BridgeNavigationReadResult>? response, out string reason) => state.BridgeSession!.TryNavigationRead(generation, r, out response, out reason), out _);
    }

    private string? HandleExecute(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeExecutionRequest, BridgeReceipt>(state,
        BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? request, out _) ? request : null,
        (BridgeEnvelope<BridgeExecutionRequest> request, out BridgeEnvelope<BridgeReceipt>? response, out string reason) => state.BridgeSession!.TryExecute(generation, request, out response, out reason), out _);

    private string? HandleCancel(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeCancelRequest, BridgeReceipt>(state,
        BridgeProtocol.TryDeserializeInbound(json, "cancel_request", out BridgeEnvelope<BridgeCancelRequest>? request, out _, "requestId", "executionId", "cancelId", "cancelEpoch", "reasonCode") ? request : null,
        (BridgeEnvelope<BridgeCancelRequest> request, out BridgeEnvelope<BridgeReceipt>? response, out string reason) => state.BridgeSession!.TryCancel(generation, request, out response, out reason), out _);

    private string? HandleExecutionReceiptQuery(ScreenEmbodimentState state, long generation, string json, string? correlationId)
    {
        if (!BridgeProtocol.TryDeserializeExecutionReceiptQuery(json, out BridgeEnvelope<BridgeExecutionReceiptQuery>? request, out string parseReason) || request is null)
            return this.SerializeError(state, correlationId, parseReason);
        return this.SerializeBridgeResponse<BridgeExecutionReceiptQuery, BridgeReceipt>(state, request,
            (BridgeEnvelope<BridgeExecutionReceiptQuery> r, out BridgeEnvelope<BridgeReceipt>? response, out string reason) => state.BridgeSession!.TryQueryExecutionReceipt(generation, r, out response, out reason), out _);
    }

    private string? HandleCompanionPresentation(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeCompanionPresentationRequest, BridgeCompanionPresentationReceipt>(state,
        BridgeProtocol.TryDeserializeInbound(json, "companion_presentation_request", out BridgeEnvelope<BridgeCompanionPresentationRequest>? request, out _, "expressionId", "sourceEventId", "text", "locale", "expectedRevision", "presentationEpoch") ? request : null,
        (BridgeEnvelope<BridgeCompanionPresentationRequest> request, out BridgeEnvelope<BridgeCompanionPresentationReceipt>? response, out string reason) =>
            state.BridgeSession!.TryPresentCompanionText(generation, request, this.TrySendCompanionPresentation, out response, out reason), out _);

    private string? HandleSystemNotice(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeSystemNoticeRequest, BridgeSystemNoticeReceipt>(state,
        BridgeProtocol.TryDeserializeInbound(json, "system_notice_request", out BridgeEnvelope<BridgeSystemNoticeRequest>? request, out _, "noticeId", "key", "text", "locale") ? request : null,
        (BridgeEnvelope<BridgeSystemNoticeRequest> request, out BridgeEnvelope<BridgeSystemNoticeReceipt>? response, out string reason) =>
            state.BridgeSession!.TryPresentSystemNotice(generation, request, this.TrySendSystemNotice, out response, out reason), out _);

    private string? HandlePlayerControlReceipt(ScreenEmbodimentState state, long generation, string json, string? correlationId)
    {
        if (!BridgeProtocol.TryDeserializeInbound(json, "player_control_receipt", out BridgeEnvelope<BridgePlayerControlReceipt>? receipt, out _, "controlId", "sourceEventId", "status"))
            return this.SerializeError(state, correlationId, "invalid_player_control_receipt");
        if (!state.BridgeSession!.TryAcceptPlayerControlReceipt(generation, receipt, out string reasonCode))
            return this.SerializeError(state, correlationId, reasonCode);
        this.MonitorNativeChatIngress("ai_player_control_host_accepted");
        return null;
    }

    /// <summary>Final game-thread presentation authority; no UI injection or envelope echo.</summary>
    private bool TrySendCompanionPresentation(BridgeCompanionPresentationRequest request) => this.TrySendNativeChat(request.Text, request.Locale);

    private bool TrySendSystemNotice(BridgeSystemNoticeRequest request) => this.TrySendNativeChat(request.Text, request.Locale);

    private bool TrySendNativeChat(string text, string locale)
    {
        if (!this.IsConfiguredAiScreen(out Farmer? farmhand, out _)
            || !NativeChatPresentationPolicy.IsBoundHumanRecipient(farmhand)
            || !NativeChatPresentationPolicy.IsCurrentLocale(locale))
            return false;
        // This is the sole egress reflection: the exact static Game1 multiplayer
        // field with the exact native type. Visibility varies by target build;
        // identity and type are the authority boundary. Any drift fails closed.
        FieldInfo? field = typeof(Game1).GetField("multiplayer", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
        if (!NativeChatPresentationPolicy.IsExactMultiplayerField(field)
            || field!.GetValue(null) is not Multiplayer multiplayer)
            return false;
        multiplayer.sendChatMessage(LocalizedContentManager.CurrentLanguageCode, text, Game1.MasterPlayer.UniqueMultiplayerID);
        return true;
    }

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

    /// <summary>
    /// Defense-in-depth gate for fixture-only console mechanics. Registration
    /// is already limited to an explicit valid NativeLocalPlayerFixture config;
    /// this revalidates the same admission plus live fixture state on the game
    /// thread, so the commands fail closed in every other world.
    /// </summary>
    private bool RequireNativeLocalPlayerFixture(out ScreenEmbodimentState state)
    {
        state = null!;
        if (this.config.NativeLocalPlayerFixture is not { IsValid: true })
        {
            this.Monitor.Log("GameBuddy refused a fixture console command: native_local_player_fixture_admission_missing.", LogLevel.Warn);
            return false;
        }
        if (this.nativeLocalPlayerFixtureTerminal || !this.nativeLocalPlayerFixtureInitialized)
        {
            this.Monitor.Log("GameBuddy refused a fixture console command: native_local_player_fixture_not_active.", LogLevel.Warn);
            return false;
        }
        return this.RequireAiWorld(out state);
    }

    private bool IsConfiguredNativeLocalPlayer(out Farmer? localPlayer, out string reasonCode)
    {
        localPlayer = null;
        reasonCode = "world_not_ready";
        if (this.config.NativeLocalPlayerFixture is not { IsValid: true } || !Context.IsWorldReady || Game1.player is null)
            return false;
        if (Context.IsMultiplayer || Game1.getAllFarmers().Count() != 1 || !Game1.IsMasterGame || Game1.server is not null || Game1.player.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID)
        {
            reasonCode = "native_local_player_fixture_topology_mismatch";
            return false;
        }
        localPlayer = Game1.player;
        if (this.config.SaveId != Game1.uniqueIDForThisGame.ToString()
            || this.config.WorldId != Game1.MasterPlayer.UniqueMultiplayerID.ToString()
            || this.config.PlayerId != localPlayer.UniqueMultiplayerID.ToString())
        {
            reasonCode = "native_local_player_fixture_scope_mismatch";
            return false;
        }
        reasonCode = "native_local_player_fixture";
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
        state.BridgeSession?.ClearNavigationForWorldUnload();
        state.LocalPipeBridge?.Dispose();
        state.LocalPipeBridge = null;
        state.BridgeSession = null;
        state.PlayerControlReplayGuard = null;
        state.Executions = null;
    }

    private static bool TryFindNativeLocalAnimalProductApproach(StardewValley.AnimalHouse house, FarmAnimal animal, out Vector2 standingTile)
    {
        foreach (Vector2 candidate in new[]
        {
            animal.Tile + new Vector2(0f, 1f), animal.Tile + new Vector2(-1f, 0f),
            animal.Tile + new Vector2(1f, 0f), animal.Tile + new Vector2(0f, -1f),
        })
        {
            if (!house.isTileOnMap(candidate) || !house.isTilePassable(candidate)
                || house.IsTileOccupiedBy(candidate, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
                continue;
            standingTile = candidate;
            return true;
        }
        standingTile = default;
        return false;
    }

    private sealed record NativeLocalFeedFixturePending(string AnimalHouseName, Vector2 TroughTile, Vector2 StandingTile);
    private sealed record NativeLocalCollectAnimalProductFixturePending(string AnimalHouseName, long AnimalId, Vector2 AnimalTile, string ProduceId, string ToolKind);
    private sealed record NativeLocalClearHoeDirtFixturePending(string FarmName, Vector2 DirtTile, Vector2 StandingTile);
    private sealed record NativeLocalDigArtifactSpotFixturePending(string FarmName, Vector2 ArtifactTile, Vector2 StandingTile);
    private sealed record NativeLocalBaitCrabPotFixturePending(string FarmName, Vector2 TargetTile, Vector2 StandingTile, StardewValley.Objects.CrabPot Pot, StardewValley.Object Bait, long OwnerId);

    private sealed record NativeLocalPlaceCrabPotFixturePending(
        string FarmName,
        Vector2 TargetTile,
        Vector2 StandingTile,
        StardewValley.Object CrabPot,
        int CrabPotStack,
        Item?[] InventoryItems,
        int[] InventoryStacks,
        string?[] InventoryIds);

    private delegate bool TryBridgeRequest<TRequest, TResponse>(BridgeEnvelope<TRequest> request, out BridgeEnvelope<TResponse>? response, out string reasonCode);
    private static bool IsOpaqueRequestId(string value) => value.Length is >= 1 and <= 64 && value.All(character => (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');

    private sealed class ScreenEmbodimentState
    {
        internal FarmhandCapabilityPublication? CapabilityPublication { get; set; }
        internal long LastPublishedCatalogRevision { get; set; }
        internal ExecutionManager? Executions { get; set; }
        internal BridgeSession? BridgeSession { get; set; }
        internal LocalPipeBridge? LocalPipeBridge { get; set; }
        internal PlayerControlReplayGuard? PlayerControlReplayGuard { get; set; }
        internal long StopObservationEpoch { get; set; }
        internal BridgeStopObservation? PendingStopObservation { get; set; }
        internal long LastBridgeGeneration { get; set; }
        internal Queue<NativeChatPipeDelivery> NativeChatPipeDeliveries { get; } = new();
        internal TerminalReceiptDeliveryTracker TerminalReceiptDeliveryTracker { get; } = new();
    }

    private sealed record NativeChatPipeDelivery(long Generation, PipeOutboundCompletion Completion, long EnqueuedAtMs);
    private sealed record TerminalReceiptDelivery(string RequestId, ExecutionState State, long Generation, PipeOutboundCompletion Completion, long EnqueuedAtMs);
    private sealed record UnconfirmedTerminalReceipt(string RequestId, ExecutionState State, long Generation, long EnqueuedAtMs);

    /// <summary>
    /// Bounded, fail-closed tracker for terminal receipt delivery. Queue
    /// admission is not pipe delivery: an admitted terminal receipt stays
    /// pending until its exact generation-bound outbound completion settles,
    /// and only a flushed completion confirms delivery. A write-failed or
    /// unconfirmed completion demotes the receipt to a bounded unconfirmed
    /// diagnostic so a terminal outcome is never silently claimed as
    /// delivered; the exact settled receipt remains recoverable from the
    /// execution ledger by an idempotent Host observe/replay.
    /// </summary>
    internal sealed class TerminalReceiptDeliveryTracker
    {
        private const int MaximumPendingDeliveries = 16;
        private const int MaximumUnconfirmedReceipts = 16;
        private const long UnconfirmedAfterMilliseconds = 2_000;

        private readonly Queue<TerminalReceiptDelivery> pending = new();
        private readonly Queue<UnconfirmedTerminalReceipt> unconfirmed = new();

        internal enum ObserveOutcome
        {
            /// <summary>No tracked delivery settled (queue empty or the head is still within its confirmation window).</summary>
            Pending,
            /// <summary>The exact frame was flushed to the live connection; that is the only delivery evidence.</summary>
            Flushed,
            /// <summary>The exact completion resolved false; the terminal receipt was not delivered.</summary>
            WriteFailed,
            /// <summary>The head stayed unresolved past the bounded window; delivery is not confirmed.</summary>
            FlushUnconfirmed,
        }

        /// <summary>
        /// Track an admitted terminal receipt until its exact completion
        /// settles. Returns false when the bounded pending queue is full; the
        /// caller then demotes the receipt to unconfirmed (fail closed).
        /// </summary>
        internal bool TryTrack(string requestId, ExecutionState state, long generation, PipeOutboundCompletion completion, long nowMs)
        {
            if (this.pending.Count >= MaximumPendingDeliveries)
                return false;
            this.pending.Enqueue(new TerminalReceiptDelivery(requestId, state, generation, completion, nowMs));
            return true;
        }

        /// <summary>
        /// Advance the head of the pending queue. Only Flushed is delivery
        /// evidence; WriteFailed and FlushUnconfirmed both demote the head to
        /// the bounded unconfirmed diagnostic exactly once, so a terminal
        /// receipt is never silently claimed as delivered. A still-unresolved
        /// head inside its confirmation window leaves the queue untouched
        /// (Pending).
        /// </summary>
        internal ObserveOutcome Observe(long nowMs)
        {
            if (!this.pending.TryPeek(out TerminalReceiptDelivery? delivery))
                return ObserveOutcome.Pending;
            if (delivery.Completion.Result.IsCompleted)
            {
                this.pending.Dequeue();
                if (delivery.Completion.Result.GetAwaiter().GetResult())
                    return ObserveOutcome.Flushed;
                this.RetainUnconfirmed(delivery.RequestId, delivery.State, delivery.Generation, nowMs);
                return ObserveOutcome.WriteFailed;
            }
            if (nowMs - delivery.EnqueuedAtMs >= UnconfirmedAfterMilliseconds)
            {
                this.pending.Dequeue();
                this.RetainUnconfirmed(delivery.RequestId, delivery.State, delivery.Generation, nowMs);
                return ObserveOutcome.FlushUnconfirmed;
            }
            return ObserveOutcome.Pending;
        }

        /// <summary>
        /// Retain an undeliverable or unconfirmable terminal receipt as a
        /// bounded redacted exact-request diagnostic (only requestId/state/
        /// generation/clock; those already exist in the exact execution ledger
        /// and no player content or identity is added). The new record is
        /// always retained; returns false only when the bounded queue was full
        /// and its oldest record had to be evicted to keep it.
        /// </summary>
        internal bool RetainUnconfirmed(string requestId, ExecutionState state, long generation, long nowMs)
        {
            bool overflowed = false;
            if (this.unconfirmed.Count >= MaximumUnconfirmedReceipts)
            {
                this.unconfirmed.Dequeue();
                overflowed = true;
            }
            this.unconfirmed.Enqueue(new UnconfirmedTerminalReceipt(requestId, state, generation, nowMs));
            return !overflowed;
        }
    }
}
