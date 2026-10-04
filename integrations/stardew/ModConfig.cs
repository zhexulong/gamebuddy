namespace GameBuddy.Stardew;

/// <summary>Local-only pipe is opt-in and authenticated; no defaults expose a bridge.</summary>
public sealed class ModConfig
{
    public bool EnableLocalBridge { get; init; }
    public string PipeName { get; init; } = "gamebuddy-stardew";
    public string BridgeToken { get; init; } = string.Empty;
    public string SaveId { get; init; } = string.Empty;
    public string WorldId { get; init; } = string.Empty;
    public string PlayerId { get; init; } = string.Empty;
    public string CompanionId { get; init; } = string.Empty;

    /// <summary>
    /// Presentation mode for the companion game window: "visible" (default, present on desktop without stealing focus, silent, 60Hz background loop),
    /// or "hidden" (invisible, silent, 60Hz background loop).
    /// </summary>
    public string WindowMode { get; init; } = "visible";

    /// <summary>
    /// Optional BCP-47 companion presentation locale from the frontend-set
    /// language preference. When present it is the single locale contract for
    /// companion text presentation and Agent session language; when absent the
    /// Mod falls back to the live game locale. Empty string means unset.
    /// </summary>
    public string PresentationLocale { get; init; } = string.Empty;

    /// <summary>
    /// Disposable one-process harness for the existing shared action runtime.
    /// It binds only the current native local Player and must never start a
    /// LAN server, Farmhand provisioner, or second process.
    /// </summary>
    public NativeLocalPlayerFixtureConfig? NativeLocalPlayerFixture { get; init; }


    /// <summary>
    /// Opt-in diagnostic only: connect from an independent client to a LAN host,
    /// report the native available-Farmhand list, then disconnect without selecting one.
    /// </summary>
    public FarmhandProvisioningProbeConfig? FarmhandProvisioningProbe { get; init; }

    /// <summary>
    /// Opt-in, evidence-only M2 sleep-modal probe (design/tasks/active/
    /// loop-m2-cross-day-seam-decision.md §11.2). Never part of a user profile.
    /// </summary>
    public SleepModalProbeConfig? SleepModalProbe { get; init; }

    /// <summary>
    /// Opt-in, evidence-only cross-day lifecycle
    /// (<c>single_player_sleep_and_advance_day</c> and the multiplayer
    /// ready-barrier variants). Not a wire action and never part of a user profile.
    /// </summary>
    public SleepAndAdvanceDayLifecycleConfig? SleepLifecycle { get; init; }

    /// <summary>
    /// Farmers that must be online before a dispatched <c>advance_day</c> wire
    /// action may start a night. Default 1 is the honest single-player minimum; a
    /// co-op profile declares 2 so a night cannot start while the other player is
    /// still connecting.
    ///
    /// Deliberately separate from <see cref="SleepLifecycle"/>: that one arms the
    /// evidence-file lifecycle, and arming both would make the file lane own the
    /// actor while the dispatched action bounces off <c>body_owned</c>.
    /// </summary>
    public int AdvanceDayMinimumOnlineFarmers { get; init; } = 1;

    /// <summary>Formal host-side attachment authority. Disabled unless explicitly configured.</summary>
    public HostFarmhandProvisioningConfig? HostFarmhandProvisioning { get; init; }

    /// <summary>Opt-in test fixture: load a dedicated save through the native game API without UI input.</summary>
    public HostAutomationConfig? HostAutomation { get; init; }

    /// <summary>
    /// Formal Player Host native world creation. The private bootstrap composer
    /// stages this in the Player Host profile's config.json; at the main menu the
    /// Mod drives the game's own new-game entry exactly once and observes the
    /// physical slot basename the game assigned. It is a production config,
    /// deliberately decoupled from every fixture-only save-name gate.
    /// </summary>
    public WorldCreationConfig? WorldCreation { get; init; }

    /// <summary>Formal AI-client provisioning adapter. It reads only a signed manifest.</summary>
    public FarmhandProvisionerConfig? FarmhandProvisioner { get; init; }

    /// <summary>
    /// Versioned deny-by-exception policy. Every action the Mod catalog marks
    /// published or live-verified is consented by default; these fields only
    /// remove actions or whole families from the Agent-visible capability
    /// surface. <see cref="ExperimentalActions"/> is a separate test-only opt-in.
    /// </summary>
    public List<string> DeniedActions { get; init; } = new();
    public List<string> DeniedActionFamilies { get; init; } = new();

    /// <summary>
    /// Test-only actions. These never enter the default Agent surface; the
    /// fixture harness arms them so a not-yet-live-proven action can still earn
    /// its live evidence. It only opts a registration in, so it can never grant
    /// an action the registry does not define.
    /// </summary>
    public List<string> ExperimentalActions { get; init; } = new();

    /// <summary>
    /// The Agent-visible action set, derived from the Mod's own registration
    /// catalog rather than a second hand-written list. Default consent is
    /// deny-by-exception: every registration whose lifecycle is published or
    /// live-verified is on, and <see cref="DeniedActions"/> /
    /// <see cref="DeniedActionFamilies"/> are the only things that remove an
    /// action again. <see cref="ExperimentalActions"/> is a test-only opt-in and
    /// never contributes to the player-facing default.
    /// </summary>
    internal IReadOnlySet<string> EnabledActionSet => ActionPolicyEngine.ComputeEnabledActions(this.ActionPolicyOptions);

    internal ActionPolicyOptions ActionPolicyOptions => new(
        DeniedActions: this.DeniedActions,
        DeniedActionFamilies: this.DeniedActionFamilies,
        ExperimentalActions: this.ExperimentalActions);

    internal bool HasValidActionPolicy => ActionPolicyEngine.ValidateActionPolicy(this.ActionPolicyOptions);

    internal bool HasValidLocalBridgeConfiguration => EnableLocalBridge
        && BridgeProtocol.IsOpaqueId(PipeName)
        && BridgeToken.Length is >= 16 and <= 256
        && new BridgeScope("stardew", SaveId, WorldId, PlayerId, CompanionId).IsValid;

}

public sealed class NativeLocalPlayerFixtureConfig
{
    public bool Enable { get; init; }
    /// <summary>Logical name returned after target-version native load.</summary>
    public string LogicalSaveName { get; init; } = string.Empty;
    /// <summary>Exact observed target-version physical slot basename passed to SaveGame.Load.</summary>
    public string ObservedSaveSlot { get; init; } = string.Empty;
    public int TimeoutSeconds { get; init; } = 90;
    /// <summary>Bounded pre-attachment native fixture setup; empty for move-only.</summary>
    public string FixtureScenario { get; init; } = string.Empty;
    /// <summary>Private transaction-owned target chosen from the live production topology for the one-shot Navigation mutation gate.</summary>
    public string NavigationMutationTargetLabel { get; set; } = string.Empty;
    /// <summary>
    /// One-shot target-version new-game creation for a disposable local fixture.
    /// It is valid only before a save exists; after native SaveLoaded the Mod
    /// records the observed slot/scope and disables it before opening bridge.
    /// </summary>
    public NativeLocalPlayerFixtureBootstrapConfig? Bootstrap { get; init; }

    /// <summary>
    /// The closed set of fixture scenarios this build understands. Kept in one
    /// place because the same list gates both the armed and the bootstrap
    /// validation path; a scenario that appears in ModEntry's dispatcher but not
    /// here is rejected before it can run, which is exactly how a new scenario
    /// silently failed to arm.
    /// </summary>
    private static readonly string[] KnownFixtureScenarios = new[]
    {
        "", "navigation_mutation_v1", "navigation_read_only_v1", "native_till_soil_v1", "native_water_crop_v1", "native_crop_research_v1", "native_plant_seed_v1", "native_fertilize_tile_v1", "native_harvest_crop_v1", "native_pickup_forage_v1", "native_pickup_item_v1", "native_machine_inspect_v1", "native_machine_coffee_load_v1", "native_machine_coffee_collect_v1", "native_machine_navigate_ab_v1", "native_npc_relationship_v1", "native_interact_npc_with_item_v1", "native_pet_animal_v1", "native_water_pet_bowl_v1", "native_water_slime_hutch_trough_v1", "native_use_item_v1", "native_place_wood_fence_v1", "native_chop_tree_source_v1", "native_break_rock_source_v1", "native_clear_hoedirt_v1", "native_clear_debris_resource_clump_v1", "native_water_crop_empty_can_recovery_v1", "native_harvest_crop_inventory_full_recovery_v1", "native_stamina_recovery_v1", "native_refill_watering_can_v1", "native_feed_animal_v1", "native_collect_animal_product_v1", "native_dig_artifact_spot_v1", "native_place_crab_pot_v1", "native_bait_crab_pot_v1", "native_chest_store_v1", "native_chest_retrieve_v1", "native_fridge_store_v1", "native_fridge_retrieve_v1", "native_ship_item_island_v1", "native_chop_stump_v1", "native_plant_sapling_v1", "native_cut_weeds_v1", "native_cut_grass_v1", "native_scythe_crop_v1", "native_harvest_bush_v1", "native_harvest_fruit_tree_v1", "native_shake_tree_v1", "native_take_pedestal_item_v1", "native_toggle_fence_gate_v1", "native_craft_item_v1", "native_clear_cask_v1", "native_dress_mannequin_v1", "native_set_sign_display_v1", "native_deposit_silo_hay_v1", "native_toggle_tool_light_v1", "native_cook_recipe_v1", "native_craft_item_partial_v1", "native_crab_pot_collect_v1", "native_ship_item_v1", "native_jodi_harvest_deliver_v1", "native_pass_out_v1", "native_ride_minecart_v1", "native_ride_bus_v1", "native_use_raft_v1", "native_mount_transport_v1", "native_enter_mine_v1",
        // Ladder 5 embodied-memory covenant probe (design
        // chat-long-horizon-memory-probe-design.md §10.5 class 1): the declared
        // Given is one mature Strawberry crop on the Farm plus the naturally-
        // loaded Shipping Bin. Production alone harvests the crop; the covenant
        // under test is that no harvested strawberry is ever shipped, so the
        // fixture never ships anything and never touches the bin.
        "native_strawberry_covenant_v1",
        // Pure embodied-actor expression actions: Farmer.doEmote / Farmer
        // .faceDirection need no world object, inventory slot or prior action,
        // so this scenario provisions no fixture fact at all.
        "native_express_emote_v1",
        // The move-stall probe stands a NATIVE挡路实体 (Pet, or a parked Horse as
        // the generic NPC-class case) on the middle tile of a three-collinear
        // walkable line (actor → blocker → target). A* plans straight through the
        // middle because pathfinding skips character collision; execution then
        // collides. The probe measures whether the native pushing/pass-through
        // mechanisms resolve the block (Pet:~1.7s push-away, NPC:1.5s pass-through)
        // before the 5000ms path-cancel, or whether the controller dies early with
        // native_path_ended. Two scenarios: pet vs horse.
        "native_move_stall_probe_pet_v1", "native_move_stall_probe_npc_v1",
        "native_wia_modal_interrupt_v1", "native_wia_modal_dismiss_chain_v1", "native_wia_pass_out_v1", "native_wia_answer_question_v1", "native_wia_eat_interrupt_v1",
          "native_wia_tool_approach_interrupt_v1", "native_wia_animal_product_interrupt_v1", "native_wia_item_pickup_interrupt_v1",

    };

    internal bool IsValid => Enable
        && LogicalSaveName.Length is >= 1 and <= 96
        && LogicalSaveName.StartsWith("GameBuddyFixture", StringComparison.Ordinal)
        && LogicalSaveName.All(char.IsLetterOrDigit)
        && IsObservedFixtureSlot(ObservedSaveSlot, LogicalSaveName)
        && TimeoutSeconds is >= 10 and <= 300
        && NavigationMutationTargetLabel.Length <= 128
        && (FixtureScenario == "navigation_mutation_v1" || NavigationMutationTargetLabel.Length == 0)
        && KnownFixtureScenarios.Contains(FixtureScenario, StringComparer.Ordinal)
        && (Bootstrap is null || !Bootstrap.Enable);

    internal bool IsBootstrapValid => Enable
        && TimeoutSeconds is >= 10 and <= 300
        && NavigationMutationTargetLabel.Length <= 128
        && (FixtureScenario == "navigation_mutation_v1" || NavigationMutationTargetLabel.Length == 0)
        && KnownFixtureScenarios.Contains(FixtureScenario, StringComparer.Ordinal)
        && Bootstrap is { IsValid: true };

    private static bool IsObservedFixtureSlot(string slot, string logicalName)
    {
        string filtered = new(logicalName.Where(char.IsLetterOrDigit).ToArray());
        if (!slot.StartsWith(filtered + "_", StringComparison.Ordinal))
            return false;
        string suffix = slot[(filtered.Length + 1)..];
        return suffix.Length is >= 1 and <= 32 && suffix.All(char.IsDigit);
    }
}

/// <summary>
/// Frozen formal world-creation request staged into the Player Host profile's
/// config.json by the private bootstrap composer. The Mod creates one world
/// from this form and observes the slot the game assigned; the Host never names
/// or writes the slot. Unlike <see cref="NativeLocalPlayerFixtureBootstrapConfig"/>
/// it carries no fixture save-name prefix and is a legitimate production config.
/// </summary>
public sealed class WorldCreationConfig
{
    public bool Enable { get; init; }
    public string FarmName { get; init; } = string.Empty;
    public string PlayerName { get; init; } = string.Empty;
    public string FavoriteThing { get; init; } = string.Empty;
    public bool CreateOnce { get; init; }

    /// <summary>
    /// A world is created once per request. The Mod refuses to arm when the
    /// request does not pin that intent, so a staged form can never silently
    /// become a repeated new-game driver.
    /// </summary>
    internal bool IsValid => Enable
        && CreateOnce
        && FarmName.Length is >= 1 and <= 32
        && FarmName.All(IsSlotSafeFarmNameText)
        && PlayerName.Length is >= 1 and <= 64
        && PlayerName.All(IsPlayerNameText)
        && FavoriteThing.Length is >= 1 and <= 32
        && FavoriteThing.All(IsDisplayText);

    /// <summary>
    /// The farm name is the only creation field that reaches the world identity:
    /// the observed slot basename is the name's letters and digits plus the game's
    /// unique id. That slot travels inside the signed join manifest, which the
    /// Host re-serializes and verifies with its own JSON encoder, so a non-ASCII
    /// character would be escaped on one side and written literally on the other
    /// and the HMAC could never match. Restricting the staged farm name to ASCII
    /// keeps the cross-language signature stable instead of adding a
    /// normalization pass for display text the Host itself chooses. Spaces are
    /// accepted for display and are dropped when the slot basename is derived.
    /// </summary>
    private static bool IsSlotSafeFarmNameText(char character) =>
        (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == ' ';

    /// <summary>Display text the native new-game setup accepts: letters, digits and ordinary name punctuation.</summary>
    private static bool IsDisplayText(char character) =>
        char.IsLetterOrDigit(character) || character is ' ' or '-' or '\'' or '.';

    /// <summary>The same bounded native player-name alphabet the fixture bootstrap already enforces.</summary>
    private static bool IsPlayerNameText(char character) =>
        char.IsLetterOrDigit(character) || character is '_' or '-';
}

public sealed class NativeLocalPlayerFixtureBootstrapConfig
{
    public bool Enable { get; init; }
    public string SaveName { get; init; } = string.Empty;
    public string PlayerName { get; init; } = "GameBuddy";

    internal bool IsValid => Enable
        && SaveName.Length is >= 1 and <= 96
        && SaveName.StartsWith("GameBuddyFixture", StringComparison.Ordinal)
        && SaveName.All(char.IsLetterOrDigit)
        && PlayerName.Length is >= 1 and <= 64
        && PlayerName.All(character => char.IsLetterOrDigit(character) || character is '_' or '-');
}


public sealed class HostFarmhandProvisioningConfig
{
    /// <summary>Launcher-only generation published by a directly spawned Player Host.</summary>
    internal string LaunchGeneration { get; set; } = string.Empty;
    public bool Enable { get; init; }
    public string SessionDirectory { get; init; } = string.Empty;
    public string SessionToken { get; init; } = string.Empty;
    public string IntegrationVersion { get; init; } = "0.1.0";
    public string FarmhandName { get; init; } = "GameBuddy";
    public int ManifestLifetimeSeconds { get; init; } = 120;
    public List<string> AuthorizedCompanionIds { get; init; } = new();

    internal bool IsValid => Enable
        && Path.IsPathFullyQualified(SessionDirectory)
        && FarmhandProvisioningProtocol.IsValidToken(SessionToken)
        && IntegrationVersion.Length is >= 1 and <= 32
        && FarmhandName.Length is >= 1 and <= 64
        && FarmhandName.All(char.IsLetterOrDigit)
        && ManifestLifetimeSeconds is >= 30 and <= 600
        && AuthorizedCompanionIds.Count > 0
        && AuthorizedCompanionIds.All(FarmhandProvisioningProtocol.IsValidOpaque);
}

public sealed class FarmhandProvisionerConfig
{
    public bool Enable { get; init; }
    public string ManifestPath { get; init; } = string.Empty;
    public string SessionToken { get; init; } = string.Empty;
    public string IntegrationVersion { get; init; } = "0.1.0";
    public int TimeoutSeconds { get; init; } = 45;

    internal bool IsValid => Enable
        && Path.IsPathFullyQualified(ManifestPath)
        && Path.GetFileName(ManifestPath).Equals(FarmhandProvisioningProtocol.ManifestFileName, StringComparison.Ordinal)
        && FarmhandProvisioningProtocol.IsValidToken(SessionToken)
        && TimeoutSeconds is >= 1 and <= 300;
}

/// <summary>Unprivileged, title-screen-only native LAN handshake diagnostic.</summary>
public sealed class HostAutomationConfig
{
    public bool Enable { get; init; }
    /// <summary>
    /// Explicit disposable native-test setup. Only the exact known scenario on
    /// a GameBuddyFixture save is accepted; it never belongs in user profiles.
    /// </summary>
    public string FixtureScenario { get; init; } = string.Empty;
    public string SaveName { get; init; } = string.Empty;
    public int TimeoutSeconds { get; init; } = 90;
    /// <summary>
    /// Preview-only live fixture gate. Empty preserves ordinary fixture behavior;
    /// supported non-empty values are exact release-verified native BCP-47 locales.
    /// </summary>
    public string RequireFixtureLiveLocale { get; init; } = string.Empty;
    public bool TriggerNativeSaveAfterAttachment { get; init; }
    public bool TriggerNativeSaveAfterClientExit { get; init; }

    internal bool IsValid => Enable
        && SaveName.Length is >= 1 and <= 128
        && SaveName.EndsWith("_", StringComparison.Ordinal) is false
        && SaveName.All(character => char.IsLetterOrDigit(character) || character is '_' or '-')
        && (RequireFixtureLiveLocale.Length == 0 || NativeChatPresentationPolicy.IsRequiredLiveLocale(RequireFixtureLiveLocale))
        && (FixtureScenario.Length == 0 || (SaveName.StartsWith("GameBuddyFixture_", StringComparison.Ordinal)
            && FixtureScenario is "native_animal_product_v2" or "native_feed_animal_v1" or "native_water_crop_v1" or "native_fertilize_tile_v1" or "native_plant_seed_v1" or "native_till_soil_v1" or "native_machine_inspect_v1" or "native_npc_relationship_v1" or "native_interact_npc_with_item_v1" or "native_pickup_forage_v1" or "native_pickup_item_v1" or "native_use_item_v1" or "native_harvest_crop_v1" or "native_jodi_harvest_deliver_v1" or "native_ship_item_v1" or "native_chest_retrieve_v1" or "native_pet_animal_v1" or "native_water_pet_bowl_v1" or "native_ride_minecart_v1"));
}

public sealed class FarmhandProvisioningProbeConfig
{
    public bool Enable { get; init; }
    public string HostAddress { get; init; } = string.Empty;
    public int TimeoutSeconds { get; init; } = 15;
    public bool ActivateExpectedFarmhand { get; init; }
    public string ExpectedFarmhandId { get; init; } = string.Empty;

    internal bool IsValid => Enable
        && HostAddress.Length is >= 1 and <= 255
        && HostAddress.All(character => char.IsLetterOrDigit(character) || character is '.' or ':' or '-');

    internal bool HasExpectedFarmhand => long.TryParse(ExpectedFarmhandId, out _);
}
