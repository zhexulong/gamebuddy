using System.Reflection;
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
    private bool hostAutomationFixtureInitialized;
    private bool hostAutomationFixtureReadinessPublished;

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
        if (!this.config.HasValidActionPolicy)
        {
            this.provisioningConfigurationRejected = true;
            this.Monitor.Log("GameBuddy rejected Stardew Game Action policy: use ActionPolicyVersion 1 with known DeniedActions/DeniedActionFamilies, or an explicit legacy EnabledActions configuration.", LogLevel.Error);
            return;
        }
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
        // Fixture setup, when explicitly armed, runs on the Host game thread
        // before a LAN server/attachment exists. It never calls production actions.
        this.TryInitializeNativeFixtureScenario();
        // Start the diagnostic host only after SMAPI confirms the world is fully available.
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
        this.TryInitializeNativeFixtureScenario();
        this.TryStartHostAutomation();
        this.TryStartFarmhandProvisioner();
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
        this.ObserveBridgeGeneration(state);
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
            if (automation.FixtureScenario.Length > 0 && !this.hostAutomationFixtureInitialized)
                return;
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
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
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
            this.hostFarmhandProvisioner.PublishFixtureReadiness(automation.FixtureScenario, automation.SaveName, state, reasonCode);
            this.hostAutomationFixtureReadinessPublished = true;
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
        if (this.TryGetAiState(out ScreenEmbodimentState state) && e.Player.UniqueMultiplayerID == Game1.player.UniqueMultiplayerID)
        {
            ExecutionManager executions = state.Executions!;
            executions.CompleteTravelAfterWarp();
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
        // A request can arrive while the previous native SaveGameMenu cycle is
        // still settling. Release the fixture latch at the authoritative Saved
        // edge so a newly pending attachment can request its own native save.
        this.hostAutomationSaveMenuOpened = false;
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

    private void ObserveBridgeGeneration(ScreenEmbodimentState state)
    {
        if (state.LocalPipeBridge is null || state.Executions is null)
            return;

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
        internal long LastBridgeGeneration { get; set; }
    }
}
