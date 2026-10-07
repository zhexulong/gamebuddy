using System.Reflection;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Navigation;
using GameBuddy.Stardew.Handlers;
using GameBuddy.Stardew.Sensory;
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
    private SleepModalProbe? sleepModalProbe;
    private bool sleepModalProbeRejected;
    private PathPredicateProbe? pathPredicateProbe;
    private SleepAndAdvanceDayLifecycle? sleepLifecycle;
    private bool sleepLifecycleRejected;
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
    private long nativeLocalPlayerFixtureLastHeartbeatUnixMs;
    private bool nativeLocalPlayerFixtureBootstrapInvoked;
    private bool nativeLocalPlayerFixtureBootstrapTerminal;
    private WorldCreationBootstrap? worldCreationBootstrap;
    private NativeLocalFeedFixturePending? nativeLocalFeedFixturePending;
    private NativeLocalCollectAnimalProductFixturePending? nativeLocalCollectAnimalProductFixturePending;
    private NativeLocalClearHoeDirtFixturePending? nativeLocalClearHoeDirtFixturePending;
    private NativeLocalUseObeliskFixturePending? nativeLocalUseObeliskFixturePending;
    private NativeLocalDigArtifactSpotFixturePending? nativeLocalDigArtifactSpotFixturePending;
    private NativeLocalPlaceCrabPotFixturePending? nativeLocalPlaceCrabPotFixturePending;
    private NativeLocalBaitCrabPotFixturePending? nativeLocalBaitCrabPotFixturePending;
    private sealed record NativeLocalMoveStallProbePending(string FarmName, Vector2 PlannedAnchor, bool UseHorseBlock);
    private NativeLocalMoveStallProbePending? nativeLocalMoveStallProbePending;
    private bool nativeChatObservationInstalled;
    private bool nativeChatStopCommandRegistered;
    private static ModEntry? nativeChatIngressOwner;
    private StardewSalientEventHooks? salientEventHooks;
    private readonly ISalientEventFilter salientEventFilter = new SalientEventFilter();

    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        this.salientEventHooks = new StardewSalientEventHooks(
            helper.Events,
            this.salientEventFilter,
            () => this.TryGetAiState(out ScreenEmbodimentState state) ? state.BridgeSession : null,
            () => this.TryGetAiState(out ScreenEmbodimentState state) ? state.BridgeSession?.Scope : null,
            this.Monitor);
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
        this.ApplyWindowModeInitial();
        this.Monitor.Log($"GameBuddy health: SMAPI lifecycle hooks are available for Stardew {Game1.version} / multiplayer {StardewValley.Multiplayer.protocolVersion}.", LogLevel.Trace);
        if (!this.config.HasValidActionPolicy)
        {
            this.provisioningConfigurationRejected = true;
            this.Monitor.Log("GameBuddy rejected Stardew Game Action policy: DeniedActions/DeniedActionFamilies must name registrations the Mod catalog defines, and ExperimentalActions may only name registrations whose lifecycle is experimental.", LogLevel.Error);
            return;
        }
        // Formal Player Host world creation is a production path and is armed
        // before (and independently of) any fixture branch: it is never gated by
        // the fixture-only GameBuddyFixture save-name checks.
        if (this.config.WorldCreation?.Enable == true)
        {
            if (this.config.WorldCreation is not { IsValid: true })
            {
                this.provisioningConfigurationRejected = true;
                this.Monitor.Log("GameBuddy rejected the formal Player Host WorldCreation configuration: a non-empty farm/player/favorite identity and CreateOnce are required.", LogLevel.Error);
                return;
            }
            this.worldCreationBootstrap = new WorldCreationBootstrap(this.config.WorldCreation, this.Monitor);
            this.Monitor.Log("GameBuddy formal Player Host world creation armed: the Mod will drive the native new-game entry once at the main menu and observe the physical slot it assigns.", LogLevel.Info);
        }
        if (this.config.NativeLocalPlayerFixture?.Enable == true)
        {
            if ((!this.config.NativeLocalPlayerFixture.IsValid && !this.config.NativeLocalPlayerFixture.IsBootstrapValid)
                || this.config.HostFarmhandProvisioning?.Enable == true
                || this.config.FarmhandProvisioner?.Enable == true
                || this.config.HostAutomation?.Enable == true)
            {
                this.provisioningConfigurationRejected = true;
                this.Monitor.Log("GameBuddy rejected NativeLocalPlayerFixture configuration: it requires a GameBuddyFixture save and no HostAutomation, Farmhand provisioning, or LAN host.", LogLevel.Error);
                return;
            }
            this.hostRoleConfigured = false;
            this.Monitor.Log(this.config.NativeLocalPlayerFixture.Bootstrap is { Enable: true }
                ? "GameBuddy native-local-player fixture bootstrap armed: target-version new-game creation will run at title screen and bridge remains closed until native SaveLoaded records its slot/scope."
                : "GameBuddy native-local-player fixture armed for its explicit observed native save slot.", LogLevel.Info);
            if (this.config.SleepModalProbe?.Enable == true)
            {
                if (this.config.SleepModalProbe is not { IsValid: true })
                {
                    this.sleepModalProbeRejected = true;
                    this.Monitor.Log("GameBuddy rejected the M2 sleep-modal probe: an absolute evidence path and mode p1_readonly/p2_answer are required.", LogLevel.Error);
                    return;
                }
                this.sleepModalProbe = SleepModalProbe.TryStart(this.Monitor, this.config.SleepModalProbe);
            }
            if (this.config.SleepLifecycle?.Enable == true)
            {
                if (!this.TryArmSleepLifecycle())
                    return;
            }
            // Env-gated evidence probe, never a config surface. It measures the
            // native path finder's goal predicate and is kept for future
            // pathing-behaviour work, so it is activated the same way the xUnit
            // seam probes are (a GAMEBUDDY_STARDEW_* variable set by the external
            // harness) rather than by a field in a user profile.
            this.pathPredicateProbe = PathPredicateProbe.TryStart(this.Monitor);
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
            // The Host is the *other* farmer in a co-op night: for the day to
            // roll over, its player must sleep too. Each process arms its own
            // lifecycle for its own farmer; neither marks the other ready.
            if (!this.TryArmSleepLifecycle())
                return;
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
            // The cross-day lifecycle is a coordinated capability, not a wire
            // action, so it is armed here rather than through the action policy.
            // It only starts once the world is ready (see OnUpdateTicked).
            if (!this.TryArmSleepLifecycle())
                return;
            // Start while the native title/farmhand menu owns available-Farmhand
            // reception; the manifest itself binds the later world scope.
            this.TryStartFarmhandProvisioner();
            return;
        }
        if (!this.TryArmSleepLifecycle())
            return;
        this.provisioningProbe = FarmhandProvisioningProbe.TryStart(this.Monitor, this.config.FarmhandProvisioningProbe);
    }

    /// <summary>
    /// Arm the opt-in cross-day lifecycle when its configuration asks for it.
    /// It is available on every topology the capability covers -- the native-local
    /// fixture lane and the formal AI-client/Farmhand lane -- because a co-op
    /// night is exactly the case the multiplayer ready barrier exists for.
    /// Returns false when the configuration is invalid, so the caller refuses the
    /// whole profile instead of running a half-configured lifecycle.
    /// </summary>
    private bool TryArmSleepLifecycle()
    {
        if (this.config.SleepLifecycle?.Enable != true)
            return true;
        if (this.config.SleepLifecycle is not { IsValid: true })
        {
            this.sleepLifecycleRejected = true;
            this.Monitor.Log("GameBuddy rejected the sleep lifecycle: an absolute evidence path and in-range budgets are required.", LogLevel.Error);
            return false;
        }
        this.sleepLifecycle = SleepAndAdvanceDayLifecycle.TryStart(this.Monitor, this.config.SleepLifecycle);
        return true;
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
        // Configuration rejection is terminal for this load.
        if (this.provisioningConfigurationRejected)
            return;
        if (this.worldCreationBootstrap is not null && !this.worldCreationBootstrap.TryComplete())
        {
            // The staged creation request exists but this loaded world is not the
            // world it produced. Fail closed: never report an existing save as a
            // created one, and never begin host attachment on an unobserved world.
            this.Monitor.Log("GameBuddy refused the loaded world because formal Player Host world creation was not observed.", LogLevel.Error);
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

    private static Vector2? FindNativeLocalMoveStallAnchor(GameLocation location)
    {
        // The probe's declared Given is "a ROUTE EXISTS from A straight through
        // blocker B to target C". That has to be true for the PLANNER, not just
        // for `isTilePassable`: A* uses `isCollidingPosition(..., pathfinding: true)`
        // (PathFindController.findPath), which additionally rejects Buildings-layer
        // tiles, building footprints, resource clumps and standing animals. A cheap
        // passability scan alone selected a Farm column that the planner refused
        // outright, and the probe then reported `no_native_path` without ever
        // exercising the blocker. So verify with the same planner the action uses,
        // from the actual start tile, and require the path to CROSS B.
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        for (int y = 4; y < height - 4; y++)
        {
            for (int x = 4; x < width - 4; x++)
            {
                Vector2 a = new(x, y);
                Vector2 b = new(x, y + 1);
                Vector2 c = new(x, y + 2);
                if (!IsMoveStallLineWalkable(location, a, b, c))
                    continue;
                if (!PlannerRoutesThrough(location, a, b, c))
                    continue;
                return a;
            }
        }
        return null;
    }

    /// <summary>
    /// True when the exact-tile planner path from <paramref name="a"/> to
    /// <paramref name="c"/> exists and steps on the blocker tile
    /// <paramref name="b"/>. Uses the static native `findPath` with the same
    /// predicate shape `move_to_tile` builds (exact tile), so the fixture proves
    /// the arrangement the probe depends on before the action ever runs.
    /// </summary>
    private static bool PlannerRoutesThrough(GameLocation location, Vector2 a, Vector2 b, Vector2 c)
    {
        Character? walker = Game1.player is { } player ? player : location.farmers.FirstOrDefault();
        if (walker is null)
            return false;
        Point target = new((int)c.X, (int)c.Y);
        Point blocker = new((int)b.X, (int)b.Y);
        Stack<Point>? path;
        try
        {
            path = StardewValley.Pathfinding.PathFindController.findPath(
                new Point((int)a.X, (int)a.Y),
                target,
                (node, endPoint, _location, _character) => node.x == endPoint.X && node.y == endPoint.Y,
                location,
                walker,
                10000);
        }
        catch (Exception)
        {
            // findPath guards against reentrancy with a static counter and throws
            // when another search is running. That is "not verified here", not a
            // fixture failure, so the scan simply moves on to the next candidate.
            return false;
        }
        return path is not null && path.Count > 0 && path.Any(tile => tile.X == blocker.X && tile.Y == blocker.Y);
    }

    private static bool IsMoveStallLineWalkable(GameLocation location, Vector2 a, Vector2 b, Vector2 c)
    {
        foreach (Vector2 tile in new[] { a, b, c })
        {
            // Farmers is excluded from the occupancy mask because the just-warped
            // actor is STANDING on tile A; its own body must not fail the very
            // arrangement it anchors. Every other class still counts, so objects,
            // terrain features, buildings and characters (NPCs, pets) still
            // disqualify a candidate.
            if (!location.isTileOnMap(tile) || !location.isTilePassable(tile)
                || location.objects.ContainsKey(tile)
                || location.terrainFeatures.ContainsKey(tile)
                || location.IsTileOccupiedBy(tile, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
                return false;
        }
        return true;
    }

    private static Vector2? FindNativeLocalArtifactSpotStandingTile(GameLocation farm, Vector2 artifactTile)
    {
        if (!farm.isTileOnMap(artifactTile)
            || farm.terrainFeatures.ContainsKey(artifactTile)
            || farm.GetHoeDirtAtTile(artifactTile) is not null
            || !farm.objects.TryGetValue(artifactTile, out StardewValley.Object? artifact)
            || !NativeItemPredicates.IsArtifactSpot(artifact)
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

    /// <summary>
    /// Resolves the companion presentation locale: the frontend-set language
    /// preference (single configuration point) when present and valid, otherwise
    /// the live game locale. BridgeSession validates the result as a BCP-47
    /// locale on every presentation.
    /// </summary>
    private static string ResolvePresentationLocale(ModConfig config)
    {
        string configured = config.PresentationLocale ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(configured)
            && NativeChatPresentationPolicy.IsValidBcp47Locale(configured))
            return configured;
        return NativeChatPresentationPolicy.CurrentBcp47Locale();
    }

    private static (Vector2 TargetTile, Vector2 StandingTile)? FindNativeLocalHarvestFullBagChestSpot(GameLocation farm, Vector2 cropTile)
    {
        // Keep the chest next to the crop so the whole recovery chain runs from one
        // standing tile: `harvest_crop` requires Chebyshev-1 to the crop and
        // `chest_store` requires Chebyshev-1 to the chest. Only a tile that satisfies
        // BOTH counts, so the retry needs no extra movement.
        Vector2[] candidates =
        {
            new(cropTile.X, cropTile.Y + 1), new(cropTile.X, cropTile.Y - 1),
            new(cropTile.X + 1, cropTile.Y), new(cropTile.X - 1, cropTile.Y),
            new(cropTile.X + 1, cropTile.Y + 1), new(cropTile.X - 1, cropTile.Y - 1),
            new(cropTile.X + 1, cropTile.Y - 1), new(cropTile.X - 1, cropTile.Y + 1),
        };
        foreach (Vector2 target in candidates)
        {
            if (!farm.isTileOnMap(target) || farm.objects.ContainsKey(target) || farm.terrainFeatures.ContainsKey(target))
                continue;
            Vector2[] cardinal =
            {
                target + new Vector2(-1f, 0f), target + new Vector2(1f, 0f),
                target + new Vector2(0f, -1f), target + new Vector2(0f, 1f),
            };
            Vector2[] validStanding = cardinal
                .Where(standing => farm.isTileOnMap(standing)
                    && farm.isTilePassable(standing)
                    && !farm.IsTileOccupiedBy(standing, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false)
                    && Math.Max(Math.Abs(standing.X - cropTile.X), Math.Abs(standing.Y - cropTile.Y)) <= 1)
                .ToArray();
            if (validStanding.Length == 1) return (target, validStanding[0]);
        }
        return null;
    }

    private static Vector2? FindNativeLocalShippingBinStandingTile(GameLocation farm, StardewValley.Buildings.ShippingBin bin)
    {
        List<Vector2> candidates = new();
        for (int x = bin.tileX.Value - 1; x <= bin.tileX.Value + bin.tilesWide.Value; x++)
        {
            for (int y = bin.tileY.Value - 1; y <= bin.tileY.Value + bin.tilesHigh.Value; y++)
            {
                Vector2 tile = new(x, y);
                if (!farm.isTileOnMap(tile) || !farm.isTilePassable(tile))
                    continue;
                if (farm.IsTileOccupiedBy(tile, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
                    continue;
                candidates.Add(tile);
            }
        }
        return candidates
            .OrderBy(tile => Math.Max(Math.Abs(tile.X - bin.tileX.Value), Math.Abs(tile.Y - bin.tileY.Value)))
            .ThenBy(tile => Math.Abs(tile.X - bin.tileX.Value) + Math.Abs(tile.Y - bin.tileY.Value))
            .Cast<Vector2?>()
            .FirstOrDefault();
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

    /// <summary>
    /// Bounded pipeline heartbeat that proves the game-thread tick path is still
    /// executing (and is not frozen in a pipe read or elsewhere). Logs at most
    /// once per 2 seconds, is content-safe, and never changes authority.
    /// </summary>
    private void LogNativeLocalPipelineHeartbeat()
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - this.nativeLocalPlayerFixtureLastHeartbeatUnixMs < 2_000L)
            return;
        this.nativeLocalPlayerFixtureLastHeartbeatUnixMs = now;
        Farmer? player = Game1.player;
        bool navigateBusy = !(player is null) && this.GetEmbodimentState().Executions?.IsBodyBusy == true;
        bool bridgeConnected = this.ReadinessBridgeConnected();
        this.Monitor.Log($"[DEBUG-native-local-heartbeat] location={player?.currentLocation?.NameOrUniqueName ?? "none"};tile={player?.TilePoint.X ?? -1},{player?.TilePoint.Y ?? -1};can_move={player?.CanMove.ToString() ?? "n/a"};navigate={(navigateBusy ? "busy" : "idle")};bridge={(bridgeConnected ? "connected" : "none")}", LogLevel.Trace);
    }

    /// <summary>Content-free bridge liveness used only by the diagnostic heartbeat.</summary>
    private bool ReadinessBridgeConnected()
    {
        return this.TryGetAiState(out ScreenEmbodimentState state) && state.BridgeSession is not null;
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
        if (!this.ClearState(state, "save_loaded"))
            return;
        bool actorConfigured = nativeLocalFixture
            ? this.IsConfiguredNativeLocalPlayer(out Farmer? localPlayer, out string reason)
            : this.IsConfiguredAiScreen(out localPlayer, out reason);
        if (!actorConfigured)
        {
            this.Monitor.Log($"GameBuddy ignored local screen {Context.ScreenId}: {reason}.", LogLevel.Trace);
            return;
        }

        state.CapabilityPublication = FarmhandCapabilityPublication.Initial(this.config.EnabledActionSet);
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
        BridgeScope executionScope = new("stardew", saveId, worldId, playerId, companionId);
        FarmhandExecutionJournal executionJournal = new(new SmapiGlobalDataPersistence(this.Helper.Data));
        state.Executions = new ExecutionManager(this.Monitor, () => state.CapabilityPublication ?? throw new InvalidOperationException("Farmhand capability publication is unavailable."),
            receipt => this.PublishReceipt(state, receipt),
            trace => this.PublishBodyTrace(state, trace),
            executionJournal,
            executionScope);
        // The profile's declared co-op night minimum governs the wire action too,
        // so a dispatched advance_day cannot quietly become a solo night when the
        // other player is not connected yet. This is deliberately a separate field
        // from SleepLifecycle: that one arms the evidence-file lifecycle, and
        // arming both would make the file lane own the actor while the dispatched
        // action bounces off `body_owned`.
        state.Executions.ConfigureLifecycleMinimumFarmers(this.config.AdvanceDayMinimumOnlineFarmers);
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

        // Body Program production authority: catalog projection, scope-fixed
        // journal store, opened journal authority, and controller are composed
        // on the owner's game thread only when the bridge scope binds and the
        // session exists. Any projection/store/open failure leaves them null
        // and the program routes fail closed with a reason code; a memory-only
        // authority is never created.
        FarmhandBodyProgramCatalogProjectionResult bodyProgramCatalogProjection;
        try
        {
            bodyProgramCatalogProjection = FarmhandBodyProgramCatalogProjection.Create();
        }
        catch
        {
            bodyProgramCatalogProjection = new FarmhandBodyProgramCatalogProjectionResult(FarmhandBodyProgramCatalogProjectionStatus.Blocked, null, Array.Empty<FarmhandBodyProgramCatalogProjectionRejection>());
        }
        BodyProgramActionCatalog? bodyProgramCatalog = bodyProgramCatalogProjection.IsPublished ? bodyProgramCatalogProjection.Catalog : null;
        WindowsBodyProgramJournalStore? bodyProgramJournalStore = null;
        OpenBodyProgramJournalAuthority? bodyProgramAuthority = null;
        FarmhandBodyProgramController? farmhandBodyProgramController = null;
        string bodyProgramUnavailableReason = "body_program_unavailable";
        if (bridgeConfigValid && scopeMatchesWorld && runtimeAttestation is not null)
        {
            if (bodyProgramCatalog is null)
            {
                bodyProgramUnavailableReason = "body_program_catalog_blocked";
                this.Monitor.Log("GameBuddy body program catalog projection blocked; program routes fail closed with body_program_catalog_blocked.", LogLevel.Warn);
            }
            else
            {
                try
                {
                    bodyProgramJournalStore = new WindowsBodyProgramJournalStore(GetBodyProgramJournalRoot(), executionScope);
                }
                catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException or UnauthorizedAccessException or IOException)
                {
                    bodyProgramUnavailableReason = "body_program_store_unavailable";
                    this.Monitor.Log($"GameBuddy body program journal store unavailable ({exception.GetType().Name}); program routes fail closed with body_program_store_unavailable.", LogLevel.Warn);
                }
                if (bodyProgramJournalStore is not null)
                {
                    try
                    {
                        bodyProgramAuthority = OpenBodyProgramJournalAuthority.Open(
                            bodyProgramJournalStore,
                            bodyProgramCatalog,
                            executionScope,
                            () => GetBodyProgramPolicyIdentity(state.CapabilityPublication!),
                            () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    }
                    catch (ArgumentException)
                    {
                        bodyProgramAuthority = null;
                    }
                    if (bodyProgramAuthority is null)
                    {
                        bodyProgramUnavailableReason = "body_program_journal_unavailable";
                        bodyProgramJournalStore.Close();
                        bodyProgramJournalStore = null;
                        this.Monitor.Log("GameBuddy body program journal open rejected scope/policy identity; program routes fail closed with body_program_journal_unavailable.", LogLevel.Warn);
                    }
                    else if (bodyProgramAuthority.OpenStatus is BodyProgramJournalOpenStatus.Corrupt or BodyProgramJournalOpenStatus.PersistenceReadFailed or BodyProgramJournalOpenStatus.PersistenceWriteFailed)
                    {
                        BodyProgramJournalOpenStatus failedStatus = bodyProgramAuthority.OpenStatus;
                        bodyProgramAuthority.Close();
                        bodyProgramAuthority = null;
                        bodyProgramJournalStore.Close();
                        bodyProgramJournalStore = null;
                        bodyProgramUnavailableReason = "body_program_journal_unavailable";
                        this.Monitor.Log($"GameBuddy body program journal unavailable ({failedStatus}); program routes fail closed with body_program_journal_unavailable.", LogLevel.Warn);
                    }
                    else if (ShouldComposeBodyProgramController(bodyProgramAuthority.OpenStatus))
                    {
                        // The controller is composed after the authenticated bridge and
                        // its pipe are created below, so its admission transport is never
                        // accidentally left null in production.
                    }
                    else
                    {
                        BodyProgramJournalOpenStatus diagnosticStatus = bodyProgramAuthority.OpenStatus;
                        bodyProgramAuthority.Close();
                        bodyProgramAuthority = null;
                        bodyProgramJournalStore.Close();
                        bodyProgramJournalStore = null;
                        bodyProgramUnavailableReason = "body_program_journal_unavailable";
                        this.Monitor.Log($"GameBuddy body program journal is diagnostic-only ({diagnosticStatus}); no controller was composed.", LogLevel.Warn);
                    }
                }
            }
        }
        state.BodyProgramCatalog = bodyProgramCatalog;
        state.BodyProgramJournalStore = bodyProgramJournalStore;
        state.BodyProgramAuthority = bodyProgramAuthority;
        state.BodyProgramUnavailableReason = bodyProgramUnavailableReason;
        state.BridgeSession = bridgeConfigValid && scopeMatchesWorld && runtimeAttestation is not null
            ? new BridgeSession(
                state.Executions,
                router,
                executionScope,
                this.config.BridgeToken,
                () => state.CapabilityPublication ?? throw new InvalidOperationException("Farmhand capability publication is unavailable."),
                presentationLocale: () => ResolvePresentationLocale(this.config),
                navigationSetProvider: () => DerivedDestinationSet.TryCreateCurrent("stardew", out DerivedDestinationSet? set, out _) ? set : null,
                runtimeAttestation: runtimeAttestation,
                sceneObservationProvider: this.TryCreateSceneObservationInput,
                bodyProgramAuthority: bodyProgramAuthority,
                bodyProgramUnavailableReason: bodyProgramUnavailableReason)
            : null;
        state.PlayerControlReplayGuard = state.BridgeSession is null ? null : new PlayerControlReplayGuard();
        state.LocalPipeBridge = state.BridgeSession is null ? null : new LocalPipeBridge(this.config.PipeName);
        state.BridgeSession?.SetPipeBridge(state.LocalPipeBridge);
        if (bodyProgramAuthority is not null
            && ShouldComposeBodyProgramController(bodyProgramAuthority.OpenStatus)
            && state.BridgeSession is not null)
        {
            // The uniform executor re-enters the single Mod dispatch table
            // (same router + ledger as ordinary execution) instead of acting as
            // a second actionId→native mapping; it is construction-private and
            // introduces no new public capability.
            farmhandBodyProgramController = new FarmhandBodyProgramController(
                bodyProgramAuthority,
                state.BridgeSession,
                new RouteReenteringBodyProgramExecutor(router, state.Executions));
            this.Monitor.Log("GameBuddy body program journal opened for this scope; program_submit/status/events routes are live.", LogLevel.Info);
        }
        state.BodyProgramController = farmhandBodyProgramController;
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
        ExpressionActionHandler expression = new(executions);
        WorldLifecycleActionHandler lifecycle = new(executions);
    ModalActionHandler modal = new(executions);
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
                FarmhandActionHandlerGroup.Expression => expression,
                FarmhandActionHandlerGroup.WorldLifecycle => lifecycle,
        FarmhandActionHandlerGroup.Modal => modal,
                _ => throw new InvalidOperationException("Unknown Farmhand execution action handler group."),
            };
            router.Register(registration, handler);
        }

        return router;
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        this.ApplyWindowModeTick();
        // This gate must precede bootstrap, binding, producer, and bridge work.
        if (this.provisioningConfigurationRejected)
            return;
        ScreenEmbodimentState pendingTeardownState = this.GetEmbodimentState();
        if (pendingTeardownState.BodyProgramTeardownPending)
        {
            this.ClearState(pendingTeardownState, "body_program_teardown_drain");
            return;
        }
        if (this.sleepModalProbeRejected || this.sleepLifecycleRejected)
            return;
        if (this.worldCreationBootstrap is { IsArmed: true })
        {
            // Drive the one native creation request while the title menu owns the
            // screen, and start no host/provisioning work until the created world
            // has been observed (or the attempt failed closed).
            this.worldCreationBootstrap.TryCreate();
            if (this.worldCreationBootstrap.IsArmed)
                return;
        }
        if (this.config.NativeLocalPlayerFixture?.Enable == true)
        {
            this.TryInitializeNativeLocalPlayerFixture();
            if (this.nativeLocalPlayerFixtureTerminal || !Context.IsWorldReady)
                return;
            if (!this.nativeLocalPlayerFixtureInitialized)
                return;
            // The path-predicate probe is a one-tick read-only measurement that
            // needs only an idle actor and the post-scenario collision field, so
            // it is consulted before any body owner and never claims the actor.
            if (this.pathPredicateProbe is not null)
            {
                if (this.pathPredicateProbe.Update())
                    this.pathPredicateProbe = null;
                return;
            }
            // The M2 sleep-modal probe owns the actor's route and the (P2)
            // answer; once the fixture scope is established it must be the only
            // body owner, so it is consulted before any bridge work.
            if (this.sleepModalProbe is not null)
            {
                if (this.sleepModalProbe.Update())
                    this.sleepModalProbe = null;
                return;
            }
            // The single-player cross-day lifecycle is the other exclusive body
            // owner on this lane: it walks to the bed, answers the native prompt
            // and observes Saving/Saved/DayStarted.
            if (this.sleepLifecycle is not null)
            {
                if (this.sleepLifecycle.Update())
                    this.sleepLifecycle = null;
                return;
            }
            this.TryInitializeEmbodiment();
            if (!this.IsConfiguredNativeLocalPlayer(out _, out _))
                return;
            this.LogNativeLocalPlayerReadinessIfBlocked();
            ScreenEmbodimentState nativeLocalState = this.GetEmbodimentState();
            this.RefreshFarmhandCapabilityPublication(nativeLocalState, e.Ticks);
            this.ObserveBridgeGeneration(nativeLocalState);
            this.ObserveNativeChatPipeDeliveries(nativeLocalState);
            this.ObserveNavigationPipeDeliveries(nativeLocalState);
            this.ObserveExecutionResponsePipeDeliveries(nativeLocalState);
            this.ObserveTerminalReceiptDeliveries(nativeLocalState);
            this.DrainLocalPipeBridge(nativeLocalState);
            this.LogNativeLocalPipelineHeartbeat();
            nativeLocalState.Executions?.Update();
            // The Body Program successor pump must run on the native-local player
            // lane exactly like the formal lane: it auto-starts dependency-free
            // sources and exact successors and parks when no authenticated
            // admission/native seams are wired. Without it, an accepted A→B
            // program stays pending on this fixture topology.
            nativeLocalState.BodyProgramController?.Update();
            this.PublishPendingStopObservation(nativeLocalState);
            return;
        }
        this.TryInitializeNativeFixtureScenario();
        this.TryStartHostAutomation();
        this.TryStartFarmhandProvisioner();
        this.hostFarmhandProvisioner?.Update();
        this.TryObserveNativeAutomationClientExit();
        this.TryTriggerNativeAutomationSave();
        this.TryInitializeNativeFixtureScenario();
        // A co-op night has one lifecycle per farmer: the Host process arms one
        // for the host player and the AI-client process arms one for the Farmhand.
        // Each owns only its own actor, so both are pumped here.
        if (this.sleepLifecycle is not null && this.sleepLifecycle.Update())
            this.sleepLifecycle = null;
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
        this.RefreshFarmhandCapabilityPublication(state, e.Ticks);
        this.ObserveBridgeGeneration(state);
        this.ObserveNativeChatPipeDeliveries(state);
        this.ObserveNavigationPipeDeliveries(state);
        this.ObserveExecutionResponsePipeDeliveries(state);
        this.ObserveTerminalReceiptDeliveries(state);
        this.DrainLocalPipeBridge(state);
        state.Executions?.Update();
        // The Body Program successor pump is a pure game-thread continuation
        // owner: it auto-starts dependency-free sources and exact successors and
        // parks when no authenticated admission/native seams are wired, so it
        // never waits for Host IPC or invents a challenge/grant while the
        // transport bridge route is still absent.
        state.BodyProgramController?.Update();
        this.PublishPendingStopObservation(state);
    }

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
        this.sleepLifecycle?.ObserveDayStarted();
        if (!this.TryGetAiState(out ScreenEmbodimentState state))
            return;
        ExecutionManager executions = state.Executions!;
        executions.ObserveDayAdvanceDayStarted();
        executions.InvalidateForLifecycle("day_started");
        this.PublishLifecycle(state, "connected", "day_started");
    }

    private void OnWarped(object? sender, WarpedEventArgs e)
    {
        if (this.nativeLocalUseObeliskFixturePending is NativeLocalUseObeliskFixturePending obeliskPending && e.Player == Game1.player)
        {
            // The location is final here, so the structure can be placed once and survive.
            if (e.NewLocation is Farm obeliskFarm
                && string.Equals(obeliskFarm.NameOrUniqueName, obeliskPending.FarmName, StringComparison.Ordinal)
                && e.Player.Tile == obeliskPending.StandingTile)
            {
                StardewValley.Buildings.Building? placed = obeliskFarm.buildings.FirstOrDefault(candidate => candidate is not null
                    && candidate.buildingType.Value == obeliskPending.BuildingType
                    && candidate.tileX.Value == (int)obeliskPending.Origin.X
                    && candidate.tileY.Value == (int)obeliskPending.Origin.Y);
                if (placed is null)
                {
                    placed = new StardewValley.Buildings.Building(obeliskPending.BuildingType, obeliskPending.Origin);
                    placed.daysOfConstructionLeft.Value = 0;
                    obeliskFarm.buildings.Add(placed);
                    obeliskFarm.updateLayout();
                }
                placed.daysOfConstructionLeft.Value = 0;

                // Ask the questions the ACTION will ask, not the ones the fixture already knows the
                // answer to. Re-testing the chosen type and Contains() on the object just added proved
                // nothing: the first live run passed those and was still refused with
                // obelisk_out_of_reach, because the actor was outside the interaction ring while the
                // check compared against the building ORIGIN tile.
                e.Player.Position = obeliskPending.StandingTile * Game1.tileSize;
                string publishedId = ExecutionManager.BuildObeliskTargetId(
                    "building",
                    obeliskFarm.NameOrUniqueName,
                    placed.buildingType.Value,
                    placed.tileX.Value,
                    placed.tileY.Value);
                ExecutionManager.ObeliskFixtureProbe probe = ExecutionManager.ProbeObeliskFixture(
                    obeliskFarm,
                    (int)placed.tileX.Value,
                    (int)placed.tileY.Value,
                    (int)e.Player.TilePoint.X,
                    (int)e.Player.TilePoint.Y,
                    publishedId);
                if (probe.Resolvable)
                {
                    this.nativeLocalUseObeliskFixturePending = null;
                    this.nativeLocalPlayerFixtureInitialized = true;
                    this.Monitor.Log(
                        "GameBuddy native-local-player initialized use_obelisk precondition before bridge attachment: "
                            + $"building_type={placed.buildingType.Value};tile={placed.tileX.Value},{placed.tileY.Value};"
                            + $"size={placed.tilesWide.Value}x{placed.tilesHigh.Value};"
                            + $"standing={(int)obeliskPending.StandingTile.X},{(int)obeliskPending.StandingTile.Y};"
                            + $"placed_after_warp=true;building_count={obeliskFarm.buildings.Count};"
                            + $"probe_tile={probe.TileX},{probe.TileY};probe_route={probe.Route};probe_identity_matches=true;probe_in_ring=true",
                        LogLevel.Info);
                    return;
                }
                this.nativeLocalUseObeliskFixturePending = null;
                this.nativeLocalPlayerFixtureTerminal = true;
                this.Monitor.Log(
                    "GameBuddy native-local-player fixture setup failed: scenario=native_use_obelisk_v1; "
                        + "error=fixture_native_local_use_obelisk_building_not_resolvable_after_warp",
                    LogLevel.Error);
                return;
            }
            this.nativeLocalUseObeliskFixturePending = null;
            this.nativeLocalPlayerFixtureTerminal = true;
            this.Monitor.Log(
                "GameBuddy native-local-player fixture setup failed: scenario=native_use_obelisk_v1; "
                    + $"error=fixture_native_local_use_obelisk_warp_landed_elsewhere;location={e.NewLocation?.NameOrUniqueName};tile={(int)e.Player.Tile.X},{(int)e.Player.Tile.Y}",
                LogLevel.Error);
            return;
        }
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
                && farm.objects.Pairs.Any(pair => NativeItemPredicates.IsArtifactSpot(pair.Value))
                && farm.objects.TryGetValue(artifactPending.ArtifactTile, out StardewValley.Object? artifact)
                && NativeItemPredicates.IsArtifactSpot(artifact)
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
                this.Monitor.Log($"GameBuddy native-local-player initialized dig-artifact-spot precondition before bridge attachment: item={artifact.QualifiedItemId}; tile={(int)artifactPending.ArtifactTile.X},{(int)artifactPending.ArtifactTile.Y}; standing_tile={(int)artifactPending.StandingTile.X},{(int)artifactPending.StandingTile.Y}; production alone performs the native hoe interaction and emits source-only receipt.", LogLevel.Info);
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
        if (this.nativeLocalMoveStallProbePending is NativeLocalMoveStallProbePending stallPending && e.Player == Game1.player)
        {
            // The warp has settled; e.Player.Tile is now the ACTUAL post-warp
            // standing tile. Rebuild the three-collinear arrangement from it so
            // the runner's A+(0,2) target really crosses the blocker.
            if (e.NewLocation is not Farm location
                || !string.Equals(location.NameOrUniqueName, stallPending.FarmName, StringComparison.Ordinal))
            {
                this.nativeLocalMoveStallProbePending = null;
                this.nativeLocalPlayerFixtureTerminal = true;
                this.Monitor.Log("GameBuddy native-local-player fixture setup failed: scenario=native_move_stall_probe; error=fixture_native_move_stall_warp_wrong_location; exception_type=InvalidOperationException.", LogLevel.Error);
                return;
            }

            Vector2 actualA = e.Player.Tile;
            Vector2 blockB = new(actualA.X, actualA.Y + 1f);
            Vector2 targetC = new(actualA.X, actualA.Y + 2f);
            if (!IsMoveStallLineWalkable(location, actualA, blockB, targetC) || !PlannerRoutesThrough(location, actualA, blockB, targetC))
            {
                this.nativeLocalMoveStallProbePending = null;
                this.nativeLocalPlayerFixtureTerminal = true;
                this.Monitor.Log($"GameBuddy native-local-player fixture setup failed: scenario=native_move_stall_probe; error=fixture_native_move_stall_post_warp_geometry_failed; actor_tile={actualA.X},{actualA.Y}; blocker_tile={blockB.X},{blockB.Y}; target_tile={targetC.X},{targetC.Y}; exception_type=InvalidOperationException.", LogLevel.Error);
                return;
            }

            if (stallPending.UseHorseBlock)
            {
                // A parked Horse is the generic NPC-class blocker: no schedule,
                // base empty behaviorOnFarmerPushing (Horse.cs does not override
                // it), farmerPassesThrough=false while idle.
                StardewValley.Characters.Horse horse = new(Guid.NewGuid(), (int)blockB.X, (int)blockB.Y);
                horse.Name = "ProbeHorse";
                location.addCharacter(horse);
                horse.currentLocation = location;
                if (!location.characters.Contains(horse) || horse.currentLocation != location)
                {
                    this.nativeLocalMoveStallProbePending = null;
                    this.nativeLocalPlayerFixtureTerminal = true;
                    this.Monitor.Log("GameBuddy native-local-player fixture setup failed: scenario=native_move_stall_probe; error=fixture_native_move_stall_horse_placement_failed; exception_type=InvalidOperationException.", LogLevel.Error);
                    return;
                }
            }
            else
            {
                StardewValley.Characters.Pet pet = new((int)blockB.X, (int)blockB.Y, "0", "Dog");
                pet.Name = "Dog";
                pet.homeLocationName.Value = location.NameOrUniqueName;
                pet.grantedFriendshipForPet.Value = false;
                pet.friendshipTowardFarmer.Value = 0;
                location.addCharacter(pet);
                pet.currentLocation = location;
                if (!location.characters.Contains(pet) || pet.currentLocation != location || pet.petId.Value == Guid.Empty || pet.grantedFriendshipForPet.Value || pet.friendshipTowardFarmer.Value != 0)
                {
                    this.nativeLocalMoveStallProbePending = null;
                    this.nativeLocalPlayerFixtureTerminal = true;
                    this.Monitor.Log("GameBuddy native-local-player fixture setup failed: scenario=native_move_stall_probe; error=fixture_native_move_stall_pet_placement_failed; exception_type=InvalidOperationException.", LogLevel.Error);
                    return;
                }
            }

            this.nativeLocalMoveStallProbePending = null;
            this.nativeLocalPlayerFixtureInitialized = true;
            this.Monitor.Log($"GameBuddy native-local-player initialized move-stall probe precondition before bridge attachment: blocker={(stallPending.UseHorseBlock ? "horse" : "pet")}; actor_tile={actualA.X},{actualA.Y}; blocker_tile={blockB.X},{blockB.Y}; target_tile={targetC.X},{targetC.Y}; production alone plans, walks, collides and emits the receipt.", LogLevel.Info);
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
        this.hostFarmhandProvisioner?.OnSaving();
        if (!this.TryGetAiState(out ScreenEmbodimentState state))
            return;
        ExecutionManager executions = state.Executions!;
        executions.InvalidateForLifecycle("saving");
        this.PublishLifecycle(state, "world_unavailable", "saving");
    }

    private void OnSaved(object? sender, SavedEventArgs e)
    {
        this.sleepLifecycle?.ObserveSaved();
        if (this.TryGetAiState(out ScreenEmbodimentState savedState))
            savedState.Executions!.ObserveDayAdvanceSaved();
        this.hostFarmhandProvisioner?.OnSaved();
        // A request can arrive while the previous native SaveGameMenu cycle is
        // still settling. Release the fixture latch at the authoritative Saved
        // edge so a newly pending attachment can request its own native save.
        this.hostAutomationSaveMenuOpened = false;
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
    {
        this.salientEventFilter.Reset();
        this.hostFarmhandProvisioner?.OnReturnedToTitle();
        this.worldCreationBootstrap?.OnReturnedToTitle();
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

    private void CancelCommand(string command, string[] args)
    {
        if (!this.RequireNativeLocalPlayerFixture(out ScreenEmbodimentState state))
            return;
        LocalExecutionReceipt receipt = state.Executions!.CancelActiveForFixture("local_console_cancel");
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    /// <summary>Game-thread only policy reload. It can only re-publish the fixed catalog's enabled subset.</summary>
    private void RefreshFarmhandCapabilityPublication(ScreenEmbodimentState state, uint currentTick)
    {
        if (state.CapabilityPublication is null || state.BridgeSession is null || state.LocalPipeBridge is null)
            return;
        // The reload re-reads config.json, so it is gated to the frozen 120-tick
        // interval instead of running on every frame; see
        // FarmhandPolicyRefreshThrottle for the bound and why it counts ticks.
        if (!state.PolicyRefreshThrottle.ShouldRefresh(currentTick))
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
        if (state.LastBridgeGeneration != generation)
        {
            // Scene refs are bound to the authenticated bridge generation. Clear
            // them on disconnect, reconnect, and any generation replacement so a
            // stale ref can never cross a transport lifecycle boundary.
            state.BridgeSession?.ClearSceneForBridgeLifecycle();
        }
        if (state.LastBridgeGeneration != 0 && generation == 0)
        {
            // A named-pipe disconnect is a local safety event. Do not wait for
            // the Host, model, TTS, or a reconnect before releasing movement.
            state.Executions.InvalidateForLifecycle("bridge_disconnected");
            this.Monitor.Log("GameBuddy invalidated the local execution because the bridge disconnected.", LogLevel.Warn);
        }
        state.LastBridgeGeneration = generation;
    }

    /// <summary>
    /// Host→Mod solicited-answer mailbox frames. These are replies to the Mod's
    /// own outbound solicitations (body-node admission results and player-control
    /// receipts); the correlation that would answer them is already settled on
    /// the Host, so a Mod response would be a reply-to-a-reply leak. They are
    /// classified here, before the RPC dispatch, and only ever deposited or
    /// observability-logged — never turned into a wire response.
    /// </summary>
    private static readonly HashSet<string> LocalBridgeMailboxAnswerTypes = new(StringComparer.Ordinal)
    {
        "body_node_admission_result",
        "player_control_receipt",
    };

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
                if (requestType == "observe_request")
                    this.MonitorNativeChatIngress("navigation_observe_dequeued");
                if (requestType == "observe_scene_request")
                    this.MonitorNativeChatIngress("scene_observe_dequeued");
                if (requestType == "execution_request")
                    this.MonitorNativeChatIngress("navigation_execution_dequeued");

                if (requestType is not null && LocalBridgeMailboxAnswerTypes.Contains(requestType))
                {
                    if (requestType == "body_node_admission_result")
                        this.HandleBodyNodeAdmissionResult(state, inbound.Generation, inbound.Json);
                    else
                        this.HandlePlayerControlReceipt(state, inbound.Generation, inbound.Json);
                    continue;
                }

                string? response = requestType switch
                {
                    "hello" => this.HandleHello(state, inbound.Generation, inbound.Json),
                    "observe_request" => this.HandleObserve(state, inbound.Generation, inbound.Json),
                    "observe_scene_request" => this.HandleObserveScene(state, inbound.Generation, inbound.Json, correlationId),
                    "navigation_read_request" => this.HandleNavigationRead(state, inbound.Generation, inbound.Json, correlationId),
                    "execution_request" => this.HandleExecute(state, inbound.Generation, inbound.Json),
                    "cancel_request" => this.HandleCancel(state, inbound.Generation, inbound.Json),
                    "execution_receipt_query" => this.HandleExecutionReceiptQuery(state, inbound.Generation, inbound.Json, correlationId),
                    "program_submit" => this.HandleProgramSubmit(state, inbound.Generation, inbound.Json, correlationId),
                    "program_status" => this.HandleProgramStatus(state, inbound.Generation, inbound.Json, correlationId),
                    "program_events" => this.HandleProgramEvents(state, inbound.Generation, inbound.Json, correlationId),
                    "companion_presentation_request" => this.HandleCompanionPresentation(state, inbound.Generation, inbound.Json),
                    "system_notice_request" => this.HandleSystemNotice(state, inbound.Generation, inbound.Json),
                    _ => this.SerializeError(state, correlationId, "unknown_message_type"),
                };

                if (response is null)
                {
                    if (requestType == "observe_request")
                        this.MonitorNativeChatIngress("navigation_observe_response_missing");
                    if (requestType == "observe_scene_request")
                        this.MonitorNativeChatIngress("scene_observe_response_missing");
                    if (requestType == "execution_request")
                        this.MonitorNativeChatIngress("navigation_execution_response_missing");
                    continue;
                }

                if (requestType == "observe_request")
                {
                    this.MonitorNativeChatIngress("navigation_observe_response_created");
                    bool enqueued = state.LocalPipeBridge.TryEnqueueOutbound(inbound.Generation, response, out PipeOutboundCompletion completion);
                    if (enqueued)
                    {
                        this.MonitorNativeChatIngress("navigation_observe_response_queued");
                        this.TrackNavigationPipeDelivery(state, inbound.Generation, completion);
                    }
                    else
                    {
                        this.MonitorNativeChatIngress("navigation_observe_response_enqueue_failed");
                    }
                    continue;
                }

                if (requestType == "observe_scene_request")
                {
                    this.MonitorNativeChatIngress("scene_observe_response_created");
                    if (!state.LocalPipeBridge.TryEnqueueOutbound(inbound.Generation, response))
                        this.MonitorNativeChatIngress("scene_observe_response_enqueue_failed");
                    else
                        this.MonitorNativeChatIngress("scene_observe_response_queued");
                    continue;
                }

                if (requestType == "execution_request")
                {
                    this.MonitorNativeChatIngress("navigation_execution_response_created");
                    bool enqueued = state.LocalPipeBridge.TryEnqueueOutbound(inbound.Generation, response, out PipeOutboundCompletion completion);
                    if (enqueued)
                    {
                        this.MonitorNativeChatIngress("navigation_execution_response_queued");
                        this.TrackExecutionResponsePipeDelivery(state, inbound.Generation, completion);
                    }
                    else
                    {
                        this.MonitorNativeChatIngress("navigation_execution_response_enqueue_failed");
                    }
                    continue;
                }

                if (!state.LocalPipeBridge.TryEnqueueOutbound(inbound.Generation, response))
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

    private void TrackNavigationPipeDelivery(ScreenEmbodimentState state, long generation, PipeOutboundCompletion completion)
    {
        if (state.NavigationPipeDeliveries.Count >= 8)
        {
            this.MonitorNativeChatIngress("navigation_observe_response_delivery_untracked");
            return;
        }
        state.NavigationPipeDeliveries.Enqueue(new NavigationPipeDelivery(generation, completion, Environment.TickCount64));
    }

    private void ObserveNavigationPipeDeliveries(ScreenEmbodimentState state)
    {
        while (state.NavigationPipeDeliveries.TryPeek(out NavigationPipeDelivery? pending))
        {
            if (pending.Completion.Result.IsCompleted)
            {
                state.NavigationPipeDeliveries.Dequeue();
                if (pending.Completion.Result.GetAwaiter().GetResult())
                    this.MonitorNativeChatIngress("navigation_observe_response_flushed");
                else
                    this.MonitorNativeChatIngress("navigation_observe_response_write_failed");
                continue;
            }
            if (Environment.TickCount64 - pending.EnqueuedAtMs >= 2_000)
            {
                state.NavigationPipeDeliveries.Dequeue();
                this.MonitorNativeChatIngress("navigation_observe_response_flush_unconfirmed");
                continue;
            }
            break;
        }
    }

    private void TrackExecutionResponsePipeDelivery(ScreenEmbodimentState state, long generation, PipeOutboundCompletion completion)
    {
        if (state.ExecutionResponsePipeDeliveries.Count >= 8)
        {
            this.MonitorNativeChatIngress("navigation_execution_response_delivery_untracked");
            return;
        }
        state.ExecutionResponsePipeDeliveries.Enqueue(new ExecutionResponsePipeDelivery(generation, completion, Environment.TickCount64));
    }

    private void ObserveExecutionResponsePipeDeliveries(ScreenEmbodimentState state)
    {
        while (state.ExecutionResponsePipeDeliveries.TryPeek(out ExecutionResponsePipeDelivery? pending))
        {
            if (pending.Completion.Result.IsCompleted)
            {
                state.ExecutionResponsePipeDeliveries.Dequeue();
                if (pending.Completion.Result.GetAwaiter().GetResult())
                    this.MonitorNativeChatIngress("navigation_execution_response_flushed");
                else
                    this.MonitorNativeChatIngress("navigation_execution_response_write_failed");
                continue;
            }
            if (Environment.TickCount64 - pending.EnqueuedAtMs >= 2_000)
            {
                state.ExecutionResponsePipeDeliveries.Dequeue();
                this.MonitorNativeChatIngress("navigation_execution_response_flush_unconfirmed");
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

    private string? HandleObserveScene(ScreenEmbodimentState state, long generation, string json, string? correlationId)
    {
        if (!BridgeProtocol.TryDeserializeObserveSceneRequest(json, out BridgeEnvelope<ObserveSceneRequestPayload>? request, out string parseReason) || request is null)
            return this.SerializeError(state, correlationId, parseReason);
        return this.SerializeBridgeResponse<ObserveSceneRequestPayload, ObserveSceneResultPayload>(state, request,
            (BridgeEnvelope<ObserveSceneRequestPayload> r, out BridgeEnvelope<ObserveSceneResultPayload>? response, out string reason) => state.BridgeSession!.TryObserveScene(generation, r, out response, out reason), out _);
    }

    private string? HandleNavigationRead(ScreenEmbodimentState state, long generation, string json, string? correlationId)
    {
        if (!BridgeProtocol.TryDeserializeNavigationReadRequest(json, out BridgeEnvelope<BridgeNavigationReadRequest>? request, out string parseReason) || request is null)
            return this.SerializeError(state, correlationId, parseReason);
        return this.SerializeBridgeResponse<BridgeNavigationReadRequest, BridgeNavigationReadResult>(state, request,
            (BridgeEnvelope<BridgeNavigationReadRequest> r, out BridgeEnvelope<BridgeNavigationReadResult>? response, out string reason) => state.BridgeSession!.TryNavigationRead(generation, r, out response, out reason), out _);
    }

    private string? HandleExecute(ScreenEmbodimentState state, long generation, string json)
    {
        if (!BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? request, out _) || request is null)
        {
            this.MonitorNativeChatIngress("navigation_execution_parse_rejected");
            return this.SerializeError(state, null, "invalid_envelope");
        }
        return this.SerializeBridgeResponse<BridgeExecutionRequest, BridgeReceipt>(state, request,
            (BridgeEnvelope<BridgeExecutionRequest> request, out BridgeEnvelope<BridgeReceipt>? response, out string reason) => state.BridgeSession!.TryExecute(generation, request, out response, out reason), out _);
    }

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


    private string? HandleProgramSubmit(ScreenEmbodimentState state, long generation, string json, string? correlationId)
    {
        if (!BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(json, out BridgeEnvelope<ActionProgramCandidate>? request, out string parseReason) || request is null)
            return this.SerializeError(state, correlationId, parseReason);
        return this.SerializeBridgeResponse<ActionProgramCandidate, BridgeBodyProgramSubmitResult>(state, request,
            (BridgeEnvelope<ActionProgramCandidate> r, out BridgeEnvelope<BridgeBodyProgramSubmitResult>? response, out string reason) => state.BridgeSession!.TryProgramSubmit(generation, r, out response, out reason), out _);
    }

    private string? HandleProgramStatus(ScreenEmbodimentState state, long generation, string json, string? correlationId)
    {
        if (!BridgeProtocol.TryDeserializeBodyProgramStatusRequest(json, out BridgeEnvelope<BridgeBodyProgramStatusRequest>? request, out string parseReason) || request is null)
            return this.SerializeError(state, correlationId, parseReason);
        return this.SerializeBridgeResponse<BridgeBodyProgramStatusRequest, BridgeBodyProgramStatusResult>(state, request,
            (BridgeEnvelope<BridgeBodyProgramStatusRequest> r, out BridgeEnvelope<BridgeBodyProgramStatusResult>? response, out string reason) => state.BridgeSession!.TryProgramStatus(generation, r, out response, out reason), out _);
    }

    private string? HandleProgramEvents(ScreenEmbodimentState state, long generation, string json, string? correlationId)
    {
        if (!BridgeProtocol.TryDeserializeBodyProgramEventsRequest(json, out BridgeEnvelope<BridgeBodyProgramEventsRequest>? request, out string parseReason) || request is null)
            return this.SerializeError(state, correlationId, parseReason);
        return this.SerializeBridgeResponse<BridgeBodyProgramEventsRequest, BridgeBodyProgramEventsResult>(state, request,
            (BridgeEnvelope<BridgeBodyProgramEventsRequest> r, out BridgeEnvelope<BridgeBodyProgramEventsResult>? response, out string reason) => state.BridgeSession!.TryProgramEvents(generation, r, out response, out reason), out _);
    }

    private string? HandleBodyNodeAdmissionResult(ScreenEmbodimentState state, long generation, string json)
    {
        if (!BridgeProtocol.TryDeserializeBodyNodeAdmissionResult(json, out BridgeEnvelope<BodyNodeAdmissionResult>? result, out string parseReason)
            || result is null)
        {
            this.Monitor.Log($"GameBuddy rejected malformed body-node admission result: {parseReason}.", LogLevel.Warn);
            return null;
        }
        if (!state.BridgeSession!.TryDepositBodyNodeAdmissionResult(generation, result, out string reasonCode))
            this.Monitor.Log($"GameBuddy rejected body-node admission result: {reasonCode}.", LogLevel.Warn);
        return null;
    }

    private string? HandleCompanionPresentation(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeCompanionPresentationRequest, BridgeCompanionPresentationReceipt>(state,
        BridgeProtocol.TryDeserializeInbound(json, "companion_presentation_request", out BridgeEnvelope<BridgeCompanionPresentationRequest>? request, out _, "expressionId", "sourceEventId", "text", "locale", "expectedRevision", "presentationEpoch") ? request : null,
        (BridgeEnvelope<BridgeCompanionPresentationRequest> request, out BridgeEnvelope<BridgeCompanionPresentationReceipt>? response, out string reason) =>
            state.BridgeSession!.TryPresentCompanionText(generation, request, this.TrySendCompanionPresentation, out response, out reason), out _);

    private string? HandleSystemNotice(ScreenEmbodimentState state, long generation, string json) => this.SerializeBridgeResponse<BridgeSystemNoticeRequest, BridgeSystemNoticeReceipt>(state,
        BridgeProtocol.TryDeserializeInbound(json, "system_notice_request", out BridgeEnvelope<BridgeSystemNoticeRequest>? request, out _, "noticeId", "key", "text", "locale") ? request : null,
        (BridgeEnvelope<BridgeSystemNoticeRequest> request, out BridgeEnvelope<BridgeSystemNoticeReceipt>? response, out string reason) =>
            state.BridgeSession!.TryPresentSystemNotice(generation, request, this.TrySendSystemNotice, out response, out reason), out _);

    private string? HandlePlayerControlReceipt(ScreenEmbodimentState state, long generation, string json)
    {
        if (!BridgeProtocol.TryDeserializeInbound(json, "player_control_receipt", out BridgeEnvelope<BridgePlayerControlReceipt>? receipt, out string parseReason, "controlId", "sourceEventId", "status"))
        {
            this.Monitor.Log($"GameBuddy rejected malformed player-control receipt: {parseReason}.", LogLevel.Warn);
            this.MonitorNativeChatIngress("ai_player_control_receipt_rejected_invalid_player_control_receipt");
            return null;
        }
        if (!state.BridgeSession!.TryAcceptPlayerControlReceipt(generation, receipt, out string reasonCode))
        {
            this.Monitor.Log($"GameBuddy rejected player-control receipt: {reasonCode}.", LogLevel.Warn);
            this.MonitorNativeChatIngress($"ai_player_control_receipt_rejected_{reasonCode}");
            return null;
        }
        this.MonitorNativeChatIngress("ai_player_control_host_accepted");
        return null;
    }

    /// <summary>Final game-thread presentation authority; no UI injection or envelope echo.</summary>
    private bool TrySendCompanionPresentation(BridgeCompanionPresentationRequest request)
    {
        // Embodied presentation: face the local player and play a light emote
        // before the native chat write. This is best-effort and never blocks
        // the text write (the presentation itself is the authority).
        if (this.IsConfiguredAiScreen(out Farmer? farmhand, out _) && farmhand is not null)
            this.TryPerformPresentationEmbodiment(farmhand);
        return this.TrySendNativeChat(request.Text, request.Locale);
    }

    /// <summary>
    /// Best-effort embodied companion presentation. Turns the companion to
    /// face the local player (choosing the dominant axis of the tile delta)
    /// and starts a light emote when idle. Failures are swallowed: a text
    /// write must still land even if the animation seam is unavailable.
    /// </summary>
    private void TryPerformPresentationEmbodiment(Farmer farmhand)
    {
        try
        {
            Farmer? player = Game1.player;
            if (player is null || player == farmhand) return;
            Vector2 delta = player.Tile - farmhand.Tile;
            int direction = Math.Abs(delta.X) > Math.Abs(delta.Y)
                ? (delta.X > 0 ? 1 : 3)
                : (delta.Y > 0 ? 2 : 0);
            farmhand.faceDirection(direction);
            // Companion emote index mirrored from the action catalog EmoteMap
            // (happy = 32); local constant only for presentation, never a new
            // action surface.
            if (!farmhand.isEmoting)
                farmhand.doEmote(32);
        }
        catch
        {
            // Embodiment is best-effort; the presentation text must still land.
        }
    }

    private bool TrySendSystemNotice(BridgeSystemNoticeRequest request) => this.TrySendNativeChat(request.Text, request.Locale);

    private bool TrySendNativeChat(string text, string locale)
    {
        if (!this.IsConfiguredAiScreen(out Farmer? farmhand, out _)
            || !NativeChatPresentationPolicy.IsBoundHumanRecipient(farmhand)
            || !NativeChatPresentationPolicy.IsCurrentLocale(locale))
            return false;

        if (Game1.IsMultiplayer && Game1.MasterPlayer.UniqueMultiplayerID != farmhand?.UniqueMultiplayerID)
        {
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

        // Local or single-player fixture presentation: deliver directly to the native chat box.
        if (Game1.chatBox is not null)
        {
            Game1.chatBox.receiveChatMessage(farmhand?.UniqueMultiplayerID ?? Game1.player.UniqueMultiplayerID, 0, LocalizedContentManager.CurrentLanguageCode, text);
            return true;
        }

        Game1.showGlobalMessage(text);
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
        if (BridgeProtocol.TrySerialize(response, out string json, out string serializeReason))
            return json;
        // The reason is what makes a live failure diagnosable; discarding it made every
        // serialization fault look identical.
        this.Monitor?.Log($"GameBuddy bridge response serialization failed: reason={serializeReason}; type={response.Type}; frameBytes={BridgeProtocol.LastFrameSizeBytes}", LogLevel.Error);
        return this.SerializeError(state, request.CorrelationId, "response_serialization_failed");
    }

    private SceneObservationInput? TryCreateSceneObservationInput()
    {
        if (!Context.IsWorldReady || Game1.player is not Farmer player || player.currentLocation is not GameLocation location
            || string.IsNullOrWhiteSpace(location.NameOrUniqueName))
            return null;

        List<SceneAffordanceSource> candidates = new();
        // Tool instances exist only to ask the target-version native harvest-tool
        // question; no action state is touched.
        MilkPail milkPail = new();
        Shears shears = new();
        foreach ((Vector2 tile, StardewValley.Object item) in location.objects.Pairs)
        {
            if (!SceneObservationScope.IsBoundedText(item.Name, 128)
                || !SceneObservationScope.IsBoundedText(item.QualifiedItemId, 128))
                continue;
            // Only real chests may be published as `chest`: an object with no
            // supported affordance is skipped rather than defaulted to a kind
            // (see SceneAffordanceKindWire.ClassifyWorldObject).
            SceneAffordanceKind? kind = SceneAffordanceKindWire.ClassifyWorldObject(
                isForage: item.isForage(),
                hasMachineData: item.GetMachineData() is not null,
                isChest: item is StardewValley.Objects.Chest,
                isArtifactSpot: NativeItemPredicates.IsArtifactSpot(item),
                isWeeds: item.IsWeeds(),
                // The scanner must advertise exactly what break_rock_source can
                // settle, which is the one-hit stone. Using the bare native
                // IsBreakableStone() here would publish a durability-8 stone as
                // a `stone` affordance with hint break_rock_source, and the
                // action would then refuse it.
                isBreakableStone: NativeItemPredicates.IsOneHitBreakableStone(item));
            if (kind is null)
                continue;
            SceneAffordanceKind resolvedKind = kind.Value;
            string? actionHint = resolvedKind switch
            {
                SceneAffordanceKind.Forage => "pickup_forage",
                SceneAffordanceKind.ArtifactSpot => "dig_artifact_spot",
                SceneAffordanceKind.Weed => "cut_weeds",
                SceneAffordanceKind.Stone => "break_rock_source",
                _ => null,
            };
            candidates.Add(new SceneAffordanceSource(resolvedKind, item.Name, item.QualifiedItemId, location.NameOrUniqueName,
                (int)tile.X, (int)tile.Y, actionHint, SceneAffordanceKindWire.DefaultPriority(resolvedKind)));
        }
        foreach (StardewValley.NPC npc in location.characters)
        {
            if (!SceneObservationScope.IsBoundedText(npc.Name, 128))
                continue;
            candidates.Add(new SceneAffordanceSource(SceneAffordanceKind.Npc, npc.Name, npc.Name, location.NameOrUniqueName,
                (int)npc.Tile.X, (int)npc.Tile.Y, "npc_relationship", SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Npc)));
        }
        foreach (FarmAnimal animal in location.animals.Values)
        {
            if (!SceneObservationScope.IsBoundedText(animal.Name, 128))
                continue;
            // Only publish the action hint whose own native precondition this
            // animal already satisfies: an adult animal carrying produce its
            // harvest tool can take. `pet_animal`'s native consumer resolves
            // `Pet` characters (cat/dog/horse), not this dictionary, and
            // `feed_animal` targets an AnimalHouse trough, so neither is
            // claimed here. Every other live state leaves the hint null.
            bool partiallyCollectable = animal.isAdult()
                && animal.currentProduce.Value is not null
                && (animal.CanGetProduceWithTool(milkPail) || animal.CanGetProduceWithTool(shears));
            candidates.Add(new SceneAffordanceSource(SceneAffordanceKind.Animal, animal.Name,
                $"animal:{animal.myID.Value}:{animal.type.Value}", location.NameOrUniqueName,
                (int)animal.Tile.X, (int)animal.Tile.Y, partiallyCollectable ? "collect_animal_product" : null,
                SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Animal)));
        }
        foreach ((Vector2 tile, var feature) in location.terrainFeatures.Pairs)
        {
            if (feature is StardewValley.TerrainFeatures.HoeDirt { crop: not null } dirt
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value))
            {
                candidates.Add(new SceneAffordanceSource(SceneAffordanceKind.Crop, "Crop", dirt.crop.indexOfHarvest.Value,
                    location.NameOrUniqueName, (int)tile.X, (int)tile.Y, "harvest_crop", SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Crop)));
            }
            // A cleared tree carries health <= 0 (the felled tree is marked
            // -100), so health > 0 selects the live ones. A stump keeps the
            // same kind and is distinguished only by its own existing action
            // hint. FruitTree is a separate TerrainFeature class with no
            // registered action, so it is deliberately not published here.
            else if (feature is StardewValley.TerrainFeatures.Tree tree && tree.health.Value > 0f)
            {
                bool stump = tree.stump.Value;
                candidates.Add(new SceneAffordanceSource(SceneAffordanceKind.Tree, stump ? "Stump" : "Tree",
                    $"tree:{location.NameOrUniqueName}:{(int)tile.X},{(int)tile.Y}:{tree.treeType.Value}",
                    location.NameOrUniqueName, (int)tile.X, (int)tile.Y, stump ? "chop_stump" : "chop_tree_source",
                    SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Tree)));
            }
        }
        foreach (StardewValley.TerrainFeatures.ResourceClump clump in location.resourceClumps)
        {
            // Debris are the ResourceClumps `clear_debris` clears (600/602 axe;
            // 148/622/672/752/754/756/758 pickaxe). A boulder or log that no
            // registered action can clear must not become an Agent-visible affordance
            // with no way to act on it.
            // Clearable exactly when the native performToolAction switch would
            // make progress on it: 600/602 axe, 148/622/672/752/754/756/758 pickaxe,
            // plus the 44/46 green-rain clumps its default arm clears. The sheet
            // value stays a local read for the identity string below.
            int sheet = clump.parentSheetIndex.Value;
            if (!SceneAffordanceKindWire.IsClearableResourceClump(clump))
                continue;
            candidates.Add(new SceneAffordanceSource(
                SceneAffordanceKind.Debris,
                clump is StardewValley.TerrainFeatures.GiantCrop ? "GiantCrop" : "Debris",
                $"debris:{location.NameOrUniqueName}:{(int)clump.Tile.X},{(int)clump.Tile.Y}:{sheet}",
                location.NameOrUniqueName,
                (int)clump.Tile.X, (int)clump.Tile.Y, "clear_debris",
                SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Debris)));
        }
        // WaterSource affordance (A.2): project each refillable water tile's
        // standable neighbors within the player radius. The ref always binds
        // the standable neighbor tile (never the water tile, which is
        // impassable); empty sets contribute nothing. This scan collects every
        // live candidate instead of stopping at MaximumAffordances: the 20-item
        // budget belongs to the projection's ranking, and a scan-time cutoff
        // would let a dense kind suppress a sparse one before ranking ran.
        for (int x = Math.Max(0, (int)player.Tile.X - SceneObservationProjection.DefaultRadius);
             x <= (int)player.Tile.X + SceneObservationProjection.DefaultRadius;
             x++)
        {
            for (int y = Math.Max(0, (int)player.Tile.Y - SceneObservationProjection.DefaultRadius);
                 y <= (int)player.Tile.Y + SceneObservationProjection.DefaultRadius;
                 y++)
            {
                if (!location.CanRefillWateringCanOnTile(x, y))
                    continue;
                foreach ((int nx, int ny) in new[] { (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1) })
                {
                    if (nx < 0 || ny < 0 || nx > 1000 || ny > 1000 || !location.isTilePassable(new xTile.Dimensions.Location(nx, ny), Game1.viewport))
                        continue;
                    candidates.Add(new SceneAffordanceSource(
                        SceneAffordanceKind.WaterSource,
                        "Water",
                        $"water_source:{x},{y}",
                        location.NameOrUniqueName,
                        nx, ny, "refill_watering_can",
                        SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.WaterSource)));
                    break;
                }
            }
        }
        foreach (Warp warp in location.warps)
        {
            if (!warp.npcOnly.Value && !string.IsNullOrWhiteSpace(warp.TargetName))
                candidates.Add(new SceneAffordanceSource(SceneAffordanceKind.Door, warp.TargetName, $"{warp.TargetName}:{warp.X}:{warp.Y}",
                    location.NameOrUniqueName, warp.X, warp.Y, "enter_exit", SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Door)));
        }
        return new SceneObservationInput(
            location.NameOrUniqueName,
            (int)player.Tile.X,
            (int)player.Tile.Y,
            candidates,
            ReadGroundTiles(location, (int)player.Tile.X, (int)player.Tile.Y));
    }

    /// <summary>
    /// Scan the actor's surroundings for the Back-layer `Type` property.
    ///
    /// <para>
    /// This reads a native map property rather than inferring a surface from
    /// objects: the engine uses the same value to choose footstep sounds
    /// (<c>GameLocation.cs:7560</c>) and to weight pathfinding
    /// (<c>PathFindController.cs</c>). Values outside the four the engine names
    /// are classified as `other` rather than dropped, so the tile count still
    /// adds up and the Agent can tell 'mostly unknown' from 'mostly grass'.
    /// </para>
    /// </summary>
    private static IReadOnlyList<SceneGroundTile> ReadGroundTiles(GameLocation location, int actorTileX, int actorTileY)
    {
        var tiles = new List<SceneGroundTile>();
        int radius = SceneObservationProjection.DefaultRadius;
        for (int y = actorTileY - radius; y <= actorTileY + radius; y++)
        {
            for (int x = actorTileX - radius; x <= actorTileX + radius; x++)
            {
                if (!location.isTileOnMap(new Vector2(x, y)))
                    continue;
                // Outside the map the property is absent; inside it, an absent
                // property is a real answer (some interiors carry no Back Type),
                // so only the on-map check decides whether to skip.
                string? backType = location.doesTileHaveProperty(x, y, "Type", "Back");
                tiles.Add(new SceneGroundTile(x, y, SceneGroundKindWire.FromBackType(backType)));
            }
        }
        return tiles;
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

    /// <summary>
    /// Documented SMAPI per-user Stardew data root for the scope-fixed
    /// BodyProgramJournal store. A missing or non-canonical root makes the store
    /// constructor fail closed in the caller; no reflection or guessed path is ever used.
    /// </summary>
    private static string GetBodyProgramJournalRoot() => StardewModdingAPI.Constants.SavesPath;

    /// <summary>
    /// Mod-minted opaque policy identity bound to this exact live capability
    /// publication. The journal authority observes it on the owner thread, so
    /// any capability/policy change quarantines stale submissions.
    /// </summary>
    internal static bool ShouldComposeBodyProgramController(BodyProgramJournalOpenStatus openStatus) => openStatus is BodyProgramJournalOpenStatus.Empty or BodyProgramJournalOpenStatus.Opened;

    private static BodyProgramPolicyIdentity GetBodyProgramPolicyIdentity(FarmhandCapabilityPublication publication)
    {
        ArgumentNullException.ThrowIfNull(publication);
        return new BodyProgramPolicyIdentity(publication.PolicyIdentity.Value, publication.CapabilityRevision);
    }

    private bool ClearState(ScreenEmbodimentState state, string reasonCode)
    {
        state.Executions?.InvalidateForLifecycle(reasonCode);
        state.BridgeSession?.ClearNavigationForWorldUnload();
        state.BridgeSession?.ClearSceneForWorldUnload();
        state.LocalPipeBridge?.Dispose();
        state.LocalPipeBridge = null;
        state.BridgeSession = null;
        state.PlayerControlReplayGuard = null;
        state.Executions = null;

        BodyProgramAuthorityLifecycleState closeState = state.BodyProgramController?.Close()
            ?? state.BodyProgramAuthority?.Close()
            ?? BodyProgramAuthorityLifecycleState.Closed;
        if (closeState == BodyProgramAuthorityLifecycleState.Draining)
        {
            state.BodyProgramTeardownPending = true;
            return false;
        }

        state.BodyProgramJournalStore?.Close();
        state.BodyProgramController = null;
        state.BodyProgramAuthority = null;
        state.BodyProgramJournalStore = null;
        state.BodyProgramCatalog = null;
        state.BodyProgramUnavailableReason = null;
        state.BodyProgramTeardownPending = false;
        return true;
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

    private sealed record NativeLocalUseObeliskFixturePending(string FarmName, string BuildingType, Vector2 Origin, Vector2 StandingTile);
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

    private sealed class SmapiGlobalDataPersistence : IModGlobalDataPersistence
    {
        private readonly IDataHelper data;

        internal SmapiGlobalDataPersistence(IDataHelper data)
        {
            this.data = data ?? throw new ArgumentNullException(nameof(data));
        }

        public FarmhandExecutionJournalState? Read(string key) => this.data.ReadGlobalData<FarmhandExecutionJournalState>(key);

        public bool TryWrite(string key, FarmhandExecutionJournalState state)
        {
            try
            {
                this.data.WriteGlobalData(key, state);
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    private sealed class ScreenEmbodimentState
    {
        internal FarmhandCapabilityPublication? CapabilityPublication { get; set; }
        internal long LastPublishedCatalogRevision { get; set; }
        internal ExecutionManager? Executions { get; set; }
        internal BridgeSession? BridgeSession { get; set; }
        internal LocalPipeBridge? LocalPipeBridge { get; set; }
        internal PlayerControlReplayGuard? PlayerControlReplayGuard { get; set; }
        internal BodyProgramActionCatalog? BodyProgramCatalog { get; set; }
        internal WindowsBodyProgramJournalStore? BodyProgramJournalStore { get; set; }
        internal OpenBodyProgramJournalAuthority? BodyProgramAuthority { get; set; }
        internal FarmhandBodyProgramController? BodyProgramController { get; set; }
        internal string? BodyProgramUnavailableReason { get; set; }
        internal bool BodyProgramTeardownPending { get; set; }
        internal long StopObservationEpoch { get; set; }
        internal BridgeStopObservation? PendingStopObservation { get; set; }
        internal long LastBridgeGeneration { get; set; }
        /// <summary>
        /// Ticks the per-frame action-policy reload. The owner froze the bound:
        /// an edit to `config.json` reaches the capability surface within 120
        /// ticks (2 s at 60 Hz). See FarmhandPolicyRefreshThrottle.
        /// </summary>
        internal FarmhandPolicyRefreshThrottle PolicyRefreshThrottle { get; } = new();
        internal Queue<NativeChatPipeDelivery> NativeChatPipeDeliveries { get; } = new();
        internal Queue<NavigationPipeDelivery> NavigationPipeDeliveries { get; } = new();
        internal Queue<ExecutionResponsePipeDelivery> ExecutionResponsePipeDeliveries { get; } = new();
        internal TerminalReceiptDeliveryTracker TerminalReceiptDeliveryTracker { get; } = new();
    }

    private sealed record NativeChatPipeDelivery(long Generation, PipeOutboundCompletion Completion, long EnqueuedAtMs);
    private sealed record NavigationPipeDelivery(long Generation, PipeOutboundCompletion Completion, long EnqueuedAtMs);
    private sealed record ExecutionResponsePipeDelivery(long Generation, PipeOutboundCompletion Completion, long EnqueuedAtMs);
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
