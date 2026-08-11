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

    /// <summary>Formal host-side attachment authority. Disabled unless explicitly configured.</summary>
    public HostFarmhandProvisioningConfig? HostFarmhandProvisioning { get; init; }

    /// <summary>Opt-in test fixture: load a dedicated save through the native game API without UI input.</summary>
    public HostAutomationConfig? HostAutomation { get; init; }

    /// <summary>Formal AI-client provisioning adapter. It reads only a signed manifest.</summary>
    public FarmhandProvisionerConfig? FarmhandProvisioner { get; init; }

    /// <summary>
    /// Versioned deny-by-exception policy. In policy version 1, all published
    /// actions are consented by default; these fields only remove actions from
    /// the Agent-visible capability surface.
    /// </summary>
    public int ActionPolicyVersion { get; init; }
    public List<string> DeniedActions { get; init; } = new();
    public List<string> DeniedActionFamilies { get; init; } = new();

    /// <summary>Test-only actions; these never enter the default Agent surface.</summary>
    public List<string> ExperimentalActions { get; init; } = new();

    /// <summary>Legacy allowlist retained only for explicit pre-policy configs.</summary>
    public List<string>? EnabledActions { get; init; }

    internal IReadOnlySet<string> EnabledActionSet
    {
        get
        {
            if (this.ActionPolicyVersion == 1)
            {
                HashSet<string> deniedActions = new(this.DeniedActions, StringComparer.Ordinal);
                HashSet<string> deniedFamilies = new(this.DeniedActionFamilies, StringComparer.Ordinal);
                HashSet<string> result = new(PublishedActions.Where(action => !deniedActions.Contains(action) && !deniedFamilies.Contains(ActionFamily(action))), StringComparer.Ordinal);
                result.UnionWith(this.ExperimentalActions.Where(action => ExperimentalActionIds.Contains(action)
                    && !deniedActions.Contains(action)
                    && !deniedFamilies.Contains(ActionFamily(action))));
                return result;
            }

            // Existing configs keep their old fail-closed allowlist semantics
            // until explicitly migrated to ActionPolicyVersion 1.
            // Legacy profiles remain explicit and fail closed. They may also
            // opt into a test-only experimental action; that action still
            // never enters the version-1 default player-facing surface.
            return new HashSet<string>((this.EnabledActions ?? Enumerable.Empty<string>()).Where(action => PublishedActions.Contains(action) || ExperimentalActionIds.Contains(action)), StringComparer.Ordinal);
        }
    }

    internal bool UsesDefaultConsentPolicy => this.ActionPolicyVersion == 1;

    internal bool HasValidActionPolicy
    {
        get
        {
            if (this.ActionPolicyVersion is not (0 or 1)) return false;
            if (this.ActionPolicyVersion == 0 && (this.DeniedActions.Count > 0 || this.DeniedActionFamilies.Count > 0)) return false;
            if (this.ActionPolicyVersion == 1 && this.EnabledActions is not null) return false;
            return this.DeniedActions.All(action => PublishedActions.Contains(action) || ExperimentalActionIds.Contains(action))
                && this.DeniedActionFamilies.All(PublishedFamilies.Contains)
                && this.ExperimentalActions.All(ExperimentalActionIds.Contains);
        }
    }

    // This is the Mod-side declaration of the same published primitive surface
    // materialized by host/src/action-registry.ts. machine_collect_output and
    // the non-registry tree-first-hit probe remain unavailable.
    private static readonly IReadOnlySet<string> PublishedActions = new HashSet<string>(new[] { "move_to_tile", "equip_tool", "travel", "enter_exit", "till_soil", "pickup_forage", "pickup_item", "water_crop", "plant_seed", "fertilize_tile", "machine_inspect", "machine_load", "machine_collect_output", "collect_animal_product", "feed_animal", "use_item", "harvest_crop", "place_wood_fence", "place_crab_pot", "chop_tree_source", "break_rock_source", "clear_hoedirt", "dig_artifact_spot", "refill_watering_can" }, StringComparer.Ordinal);
    private static readonly IReadOnlySet<string> PublishedFamilies = new HashSet<string>(new[]
    {
        "movement_navigation", "body_tools", "transport_warps", "farming_crops", "resource_gathering", "inventory_items",
        "crafting_cooking", "machines_processing", "animals_pets", "npc_social", "shops_economy",
        "buildings_farm_management", "quests_progression", "story_world_scripts", "festivals_minigames", "calendar_day_progression",
    }, StringComparer.Ordinal);
    private static readonly IReadOnlySet<string> ExperimentalActionIds = new HashSet<string>(new[] { "clear_debris", "npc_relationship", "pet_animal" }, StringComparer.Ordinal);

    private static string ActionFamily(string action) => action switch
    {
        "move_to_tile" => "movement_navigation",
        "equip_tool" => "body_tools",
        "travel" => "transport_warps",
        "enter_exit" => "movement_navigation",
        "till_soil" => "farming_crops",
        "pickup_forage" => "resource_gathering",
        "pickup_item" => "inventory_items",
        "water_crop" => "farming_crops",
        "plant_seed" => "farming_crops",
        "fertilize_tile" => "farming_crops",
        "harvest_crop" => "farming_crops",
        "place_wood_fence" => "buildings_farm_management",
        "place_crab_pot" => "buildings_farm_management",
        "clear_debris" => "resource_gathering",
        "machine_inspect" or "machine_load" or "machine_collect_output" => "machines_processing",
        "npc_relationship" => "npc_social",
        "pet_animal" => "animals_pets",
        "collect_animal_product" => "animals_pets",
        "feed_animal" => "animals_pets",
        "use_item" => "inventory_items",
        "tree_first_hit" => "resource_gathering",
        "chop_tree_source" => "resource_gathering",
        "break_rock_source" => "resource_gathering",
        "clear_hoedirt" => "farming_crops",
        "dig_artifact_spot" => "resource_gathering",
        "refill_watering_can" => "farming_crops",
        _ => string.Empty,
    };

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
    /// <summary>
    /// One-shot target-version new-game creation for a disposable local fixture.
    /// It is valid only before a save exists; after native SaveLoaded the Mod
    /// records the observed slot/scope and disables it before opening bridge.
    /// </summary>
    public NativeLocalPlayerFixtureBootstrapConfig? Bootstrap { get; init; }

    internal bool IsValid => Enable
        && LogicalSaveName.Length is >= 1 and <= 96
        && LogicalSaveName.StartsWith("GameBuddyFixture", StringComparison.Ordinal)
        && LogicalSaveName.All(char.IsLetterOrDigit)
        && IsObservedFixtureSlot(ObservedSaveSlot, LogicalSaveName)
        && TimeoutSeconds is >= 10 and <= 300
        && (FixtureScenario is "" or "native_till_soil_v1" or "native_water_crop_v1" or "native_plant_seed_v1" or "native_fertilize_tile_v1" or "native_harvest_crop_v1" or "native_pickup_forage_v1" or "native_pickup_item_v1" or "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1" or "native_npc_relationship_v1" or "native_pet_animal_v1" or "native_use_item_v1" or "native_place_wood_fence_v1" or "native_tree_first_hit_v1" or "native_chop_tree_source_v1" or "native_break_rock_source_v1" or "native_clear_hoedirt_v1" or "native_clear_debris_resource_clump_v1" or "native_refill_watering_can_v1" or "native_feed_animal_v1" or "native_collect_animal_product_v1" or "native_dig_artifact_spot_v1" or "native_place_crab_pot_v1")
        && (Bootstrap is null || !Bootstrap.Enable);

    internal bool IsBootstrapValid => Enable
        && TimeoutSeconds is >= 10 and <= 300
        && (FixtureScenario is "" or "native_till_soil_v1" or "native_water_crop_v1" or "native_plant_seed_v1" or "native_fertilize_tile_v1" or "native_harvest_crop_v1" or "native_pickup_forage_v1" or "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1" or "native_npc_relationship_v1" or "native_pet_animal_v1" or "native_use_item_v1" or "native_place_wood_fence_v1" or "native_tree_first_hit_v1" or "native_chop_tree_source_v1" or "native_break_rock_source_v1" or "native_clear_hoedirt_v1" or "native_clear_debris_resource_clump_v1" or "native_refill_watering_can_v1" or "native_feed_animal_v1" or "native_collect_animal_product_v1" or "native_dig_artifact_spot_v1" or "native_place_crab_pot_v1")
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
    public bool Enable { get; init; }
    public string SessionDirectory { get; init; } = string.Empty;
    public string Endpoint { get; init; } = "127.0.0.1:24642";
    public string SessionToken { get; init; } = string.Empty;
    public string IntegrationVersion { get; init; } = "0.1.0";
    public string ExpectedGameVersion { get; init; } = "1.6.15";
    public int ExpectedGameBuildNumber { get; init; } = 24356;
    public string ExpectedSmapiVersion { get; init; } = "4.5.2";
    public string FarmhandName { get; init; } = "GameBuddy";
    public int ManifestLifetimeSeconds { get; init; } = 120;
    public List<string> AuthorizedCompanionIds { get; init; } = new();

    internal bool IsValid => Enable
        && Path.IsPathFullyQualified(SessionDirectory)
        && FarmhandProvisioningProtocol.IsValidEndpoint(Endpoint)
        && FarmhandProvisioningProtocol.IsValidToken(SessionToken)
        && IntegrationVersion.Length is >= 1 and <= 32
        && ExpectedGameVersion == "1.6.15"
        && ExpectedGameBuildNumber == 24356
        && ExpectedSmapiVersion == "4.5.2"
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
    public string ExpectedGameVersion { get; init; } = "1.6.15";
    public int ExpectedGameBuildNumber { get; init; } = 24356;
    public string ExpectedSmapiVersion { get; init; } = "4.5.2";
    public int TimeoutSeconds { get; init; } = 45;

    internal bool IsValid => Enable
        && Path.IsPathFullyQualified(ManifestPath)
        && Path.GetFileName(ManifestPath).Equals(FarmhandProvisioningProtocol.ManifestFileName, StringComparison.Ordinal)
        && FarmhandProvisioningProtocol.IsValidToken(SessionToken)
        && ExpectedGameVersion == "1.6.15"
        && ExpectedGameBuildNumber == 24356
        && ExpectedSmapiVersion == "4.5.2"
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
    public bool TriggerNativeSaveAfterAttachment { get; init; }
    public bool TriggerNativeSaveAfterClientExit { get; init; }

    internal bool IsValid => Enable
        && SaveName.Length is >= 1 and <= 128
        && SaveName.EndsWith("_", StringComparison.Ordinal) is false
        && SaveName.All(character => char.IsLetterOrDigit(character) || character is '_' or '-')
        && (FixtureScenario.Length == 0 || (SaveName.StartsWith("GameBuddyFixture_", StringComparison.Ordinal)
            && FixtureScenario is "native_animal_product_v2" or "native_feed_animal_v1" or "native_water_crop_v1" or "native_fertilize_tile_v1" or "native_plant_seed_v1" or "native_till_soil_v1" or "native_machine_inspect_v1" or "native_npc_relationship_v1" or "native_pickup_forage_v1" or "native_pickup_item_v1" or "native_use_item_v1" or "native_harvest_crop_v1"));
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
