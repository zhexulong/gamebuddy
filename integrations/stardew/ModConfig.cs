using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;

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
    /// LAN server, Farmhand provisioner, second process, or Portfolio runtime.
    /// </summary>
    public NativeLocalPlayerFixtureConfig? NativeLocalPlayerFixture { get; init; }

    /// <summary>Independent single-player Portfolio topology. Disabled by default.</summary>
    public PortfolioConfig? Portfolio { get; init; }

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

    internal IReadOnlySet<string> EnabledActionSet =>
        ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions(
            this.ActionPolicyVersion,
            this.DeniedActions,
            this.DeniedActionFamilies,
            this.ExperimentalActions,
            this.EnabledActions));

    /// <summary>
    /// The sole Farmhand bridge publication: policy-derived game actions plus
    /// fixed protocol controls. Callers retain this immutable value for their
    /// bridge lifetime; controls never authorize game-action execution.
    /// </summary>
    internal FarmhandCapabilitySurface CreateFarmhandCapabilitySurface() =>
        FarmhandCapabilitySurface.FromEnabledActions(this.EnabledActionSet);

    internal bool UsesDefaultConsentPolicy => this.ActionPolicyVersion == 1;

    internal bool HasValidActionPolicy =>
        ActionPolicyEngine.ValidateActionPolicy(new ActionPolicyOptions(
            this.ActionPolicyVersion,
            this.DeniedActions,
            this.DeniedActionFamilies,
            this.ExperimentalActions,
            this.EnabledActions));

    // The sole Mod-side ordinary Farmhand action identity composition. Host and
    // descriptor metadata are checked projections and never publication inputs.
    internal static IReadOnlyList<FarmhandActionDefinition> FarmhandActionDefinitions => FarmhandActionCatalog.Definitions;

    internal bool HasValidLocalBridgeConfiguration => EnableLocalBridge
        && BridgeProtocol.IsOpaqueId(PipeName)
        && BridgeToken.Length is >= 16 and <= 256
        && new BridgeScope("stardew", SaveId, WorldId, PlayerId, CompanionId).IsValid;

    internal bool HasPortfolioConfiguration => this.Portfolio?.Enable == true;

    internal bool IsP0bExclusiveConfigurationValid =>
        this.Portfolio is { Enable: true, P0bLifecycleProducer: { Enable: true, IsValid: true } } portfolio
        && portfolio.Bootstrap?.Enable != true
        && portfolio.InitialNativeLoad?.Enable != true
        && this.NativeLocalPlayerFixture?.Enable != true
        && this.NativeLocalPlayerFixture?.Bootstrap?.Enable != true
        && this.HostAutomation?.Enable != true
        && this.HostFarmhandProvisioning?.Enable != true
        && this.FarmhandProvisioner?.Enable != true
        && this.FarmhandProvisioningProbe?.Enable != true;
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
        && (FixtureScenario is "" or "native_till_soil_v1" or "native_water_crop_v1" or "native_plant_seed_v1" or "native_fertilize_tile_v1" or "native_harvest_crop_v1" or "native_pickup_forage_v1" or "native_pickup_item_v1" or "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1" or "native_npc_relationship_v1" or "native_pet_animal_v1" or "native_use_item_v1" or "native_place_wood_fence_v1" or "native_chop_tree_source_v1" or "native_break_rock_source_v1" or "native_clear_hoedirt_v1" or "native_clear_debris_resource_clump_v1" or "native_refill_watering_can_v1" or "native_feed_animal_v1" or "native_collect_animal_product_v1" or "native_dig_artifact_spot_v1" or "native_place_crab_pot_v1" or "native_bait_crab_pot_v1")
        && (Bootstrap is null || !Bootstrap.Enable);

    internal bool IsBootstrapValid => Enable
        && TimeoutSeconds is >= 10 and <= 300
        && (FixtureScenario is "" or "native_till_soil_v1" or "native_water_crop_v1" or "native_plant_seed_v1" or "native_fertilize_tile_v1" or "native_harvest_crop_v1" or "native_pickup_forage_v1" or "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1" or "native_npc_relationship_v1" or "native_pet_animal_v1" or "native_use_item_v1" or "native_place_wood_fence_v1" or "native_chop_tree_source_v1" or "native_break_rock_source_v1" or "native_clear_hoedirt_v1" or "native_clear_debris_resource_clump_v1" or "native_refill_watering_can_v1" or "native_feed_animal_v1" or "native_collect_animal_product_v1" or "native_dig_artifact_spot_v1" or "native_place_crab_pot_v1" or "native_bait_crab_pot_v1")
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

public sealed class PortfolioConfig
{
    public bool Enable { get; init; }
    public string Topology { get; init; } = string.Empty;
    public bool EnableObserveBridge { get; init; }

    /// <summary>
    /// Explicit Portfolio mutation allowlist. It is default-deny: enabling the
    /// Portfolio or observe bridge never grants a mutation action implicitly.
    /// </summary>
    public List<string> EnabledActions { get; init; } = new();

    public string PipeName { get; init; } = "gamebuddy-stardew-portfolio";
    public string BridgeToken { get; init; } = string.Empty;
    public string SaveId { get; init; } = string.Empty;
    public string WorldId { get; init; } = string.Empty;
    public string LocalPlayerId { get; init; } = string.Empty;
    public string CompanionId { get; init; } = string.Empty;
    public string DataRoot { get; init; } = string.Empty;
    public string ExpectedGameVersion { get; init; } = PortfolioBridgeProtocol.TargetGameVersion;
    public int ExpectedGameBuildNumber { get; init; } = PortfolioBridgeProtocol.TargetGameBuildNumber;
    /// <summary>
    /// Explicit one-shot title-screen setup only. It creates a clean native
    /// single-player save through Stardew's own new-character lifecycle, then
    /// disables itself. It is never an action, fixture, receipt, or evidence producer.
    /// </summary>
    public PortfolioBootstrapConfig? Bootstrap { get; init; }

    /// <summary>
    /// One-shot title-screen entry into an already observed isolated Portfolio
    /// save. This is only a target-version native load edge for an action run;
    /// it is not P0b, a fixture, a save writer, or an action result producer.
    /// </summary>
    public PortfolioInitialNativeLoadConfig? InitialNativeLoad { get; init; }

    /// <summary>Explicit, default-disabled P0b native signed start-manifest producer.</summary>
    public PortfolioP0bLifecycleProducerConfig? P0bLifecycleProducer { get; init; }

    /// <summary>
    /// Internal, default-disabled M8 Given preparation for the independent
    /// enter_mine action. It is not a bridge action and produces no receipt.
    /// </summary>
    public PortfolioMineEntryGivenFixtureConfig? MineEntryGivenFixture { get; init; }

    /// <summary>
    /// Internal, default-disabled M8 Given preparation for the independent
    /// use_mine_ladder action. The fixed native destination is Mod-owned;
    /// this configuration carries no destination, pose, or action authority.
    /// </summary>
    public PortfolioMineLadderGivenFixtureConfig? MineLadderGivenFixture { get; init; }

    /// <summary>
    /// Internal, default-disabled M8 Given preparation for the independent
    /// select_mine_elevator_floor action. The fixed native destination is
    /// Mod-owned; this configuration carries no checkpoint, pose, or action authority.
    /// </summary>
    public PortfolioMineElevatorGivenFixtureConfig? MineElevatorGivenFixture { get; init; }

    // The local Player id is not known before the first native SaveLoaded. A
    // disarmed bootstrap may therefore leave it blank while retaining the
    // already-recorded save/world/companion scope; the game-thread binding
    // records and validates the actual Player id after reload.
    internal bool IsValid => Enable
        && Topology == PortfolioBridgeProtocol.Topology
        && PortfolioBridgeProtocol.IsOpaqueId(PipeName)
        && PipeName.StartsWith(PortfolioBridgeProtocol.PipeNamePrefix, StringComparison.Ordinal)
        && PortfolioBridgeProtocol.IsToken(BridgeToken)
        && PortfolioBridgeProtocol.IsOpaqueId(SaveId)
        && PortfolioBridgeProtocol.IsOpaqueId(WorldId)
        && (LocalPlayerId.Length == 0 || PortfolioBridgeProtocol.IsOpaqueId(LocalPlayerId))
        && PortfolioBridgeProtocol.IsOpaqueId(CompanionId)
        && Path.IsPathFullyQualified(DataRoot)
        && ExpectedGameVersion == PortfolioBridgeProtocol.TargetGameVersion
        && ExpectedGameBuildNumber == PortfolioBridgeProtocol.TargetGameBuildNumber
        && EnableObserveBridge
        && HasValidActionAllowlist
        && (Bootstrap is null || !Bootstrap.Enable)
        && (InitialNativeLoad is null || !InitialNativeLoad.Enable || InitialNativeLoad.IsValid)
        && (P0bLifecycleProducer is null || !P0bLifecycleProducer.Enable || P0bLifecycleProducer.IsValid)
        && (MineEntryGivenFixture is null || !MineEntryGivenFixture.Enable || MineEntryGivenFixture.IsValid)
        && (MineEntryGivenFixture is null || !MineEntryGivenFixture.Enable
            || IsMineEntryActionSequence)
        && (MineLadderGivenFixture is null || !MineLadderGivenFixture.Enable || MineLadderGivenFixture.IsValid)
        && (MineLadderGivenFixture is null || !MineLadderGivenFixture.Enable
            || IsMineLadderActionSequence)
        && (MineElevatorGivenFixture is null || !MineElevatorGivenFixture.Enable || MineElevatorGivenFixture.IsValid)
        && (MineElevatorGivenFixture is null || !MineElevatorGivenFixture.Enable
            || IsMineElevatorActionSequence);

    internal bool IsBootstrapValid => Enable
        && Topology == PortfolioBridgeProtocol.Topology
        && PortfolioBridgeProtocol.IsOpaqueId(PipeName)
        && PipeName.StartsWith(PortfolioBridgeProtocol.PipeNamePrefix, StringComparison.Ordinal)
        && PortfolioBridgeProtocol.IsToken(BridgeToken)
        && PortfolioBridgeProtocol.IsOpaqueId(CompanionId)
        && Path.IsPathFullyQualified(DataRoot)
        && ExpectedGameVersion == PortfolioBridgeProtocol.TargetGameVersion
        && ExpectedGameBuildNumber == PortfolioBridgeProtocol.TargetGameBuildNumber
        && EnableObserveBridge
        && HasValidActionAllowlist
        && Bootstrap is { IsValid: true };

    private static readonly IReadOnlySet<string> PortfolioActionIds = new HashSet<string>(
        new[] { PortfolioBridgeProtocol.SleepDayAction, PortfolioBridgeProtocol.MineElevatorAction, PortfolioBridgeProtocol.MineLadderAction, PortfolioBridgeProtocol.MineEntryAction, PortfolioBridgeProtocol.SkipEventAction },
        StringComparer.Ordinal);

    private bool HasValidActionAllowlist => this.EnabledActions.Count == this.EnabledActions.Distinct(StringComparer.Ordinal).Count()
        && this.EnabledActions.All(action => PortfolioActionIds.Contains(action));

    internal bool IsMineEntryActionSequence =>
        (this.EnabledActions.Count == 1 && this.EnabledActions[0] == PortfolioBridgeProtocol.MineEntryAction)
        || (this.EnabledActions.Count == 2
            && this.EnabledActions[0] == PortfolioBridgeProtocol.SkipEventAction
            && this.EnabledActions[1] == PortfolioBridgeProtocol.MineEntryAction);

    internal bool IsMineLadderActionSequence => this.EnabledActions.Count == 1
        && this.EnabledActions[0] == PortfolioBridgeProtocol.MineLadderAction;

    internal bool IsMineElevatorActionSequence => this.EnabledActions.Count == 1
        && this.EnabledActions[0] == PortfolioBridgeProtocol.MineElevatorAction;

    /// <summary>
    /// Rechecks the explicit Portfolio allowlist at the game-thread request
    /// boundary. This is intentionally separate from the global Farmhand policy.
    /// </summary>
    internal bool IsPortfolioActionAuthorized(string action) =>
        this.Enable
        && HasValidActionAllowlist
        && PortfolioActionIds.Contains(action)
        && this.EnabledActions.Contains(action, StringComparer.Ordinal);
}

public sealed class PortfolioMineEntryGivenFixtureConfig
{
    public bool Enable { get; init; }

    // The strongly typed bool is the complete shape contract; PortfolioConfig
    // applies the action-specific admission rule when Enable is true.
    internal bool IsValid => true;
}

public sealed class PortfolioMineLadderGivenFixtureConfig
{
    // The strongly typed bool is the complete serialized shape contract.
    // PortfolioConfig applies the exact ladder-only action admission rule.
    public bool Enable { get; init; }
    internal bool IsValid => true;
}

public sealed class PortfolioMineElevatorGivenFixtureConfig
{
    // The strongly typed bool is the complete serialized shape contract.
    // PortfolioConfig applies the exact elevator-only action admission rule.
    public bool Enable { get; init; }
    internal bool IsValid => true;
}

public sealed class PortfolioInitialNativeLoadConfig
{
    public bool Enable { get; init; }
    /// <summary>Exact observed target-version physical save slot passed to SaveGame.Load.</summary>
    public string ObservedSaveSlot { get; init; } = string.Empty;
    internal bool IsValid => Enable && IsObservedPortfolioSlot(ObservedSaveSlot);

    private static bool IsObservedPortfolioSlot(string value)
    {
        int separator = value.LastIndexOf('_');
        return value.Length is >= 21 and <= 179
            && value.StartsWith("GameBuddyPortfolio", StringComparison.Ordinal)
            && separator > "GameBuddyPortfolio".Length
            && separator < value.Length - 1
            && value[..separator].All(IsAsciiObservedSlotCharacter)
            && value[(separator + 1)..].Length is <= 32
            && value[(separator + 1)..].All(character => character is >= '0' and <= '9');
    }

    private static bool IsAsciiObservedSlotCharacter(char character) =>
        character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-';
}

public sealed class PortfolioP0bLifecycleProducerConfig
{
    public bool Enable { get; init; }
    /// <summary>Native logical name reported by the loaded world.</summary>
    public string LogicalSaveName { get; init; } = string.Empty;

    /// <summary>
    /// Existing target-version physical slot basename. It is explicit because
    /// title screen has no loaded world from which uniqueIDForThisGame can be
    /// read; it is verified again after native SaveLoaded.
    /// </summary>
    public string ObservedSaveSlot { get; init; } = string.Empty;
    /// <summary>Absolute output path for the create-only native start manifest in a dedicated external evidence directory.</summary>
    public string StartManifestPath { get; init; } = string.Empty;
    /// <summary>
    /// Name of the process environment variable containing the HMAC key. The
    /// secret itself is never deserialized into ModConfig or persisted in a
    /// profile. The producer resolves it only at manifest-write time.
    /// </summary>
    public string SigningKeyEnvironmentVariableName { get; init; } = string.Empty;
    public int TimeoutSeconds { get; init; } = 180;

    internal bool IsValid => Enable
        && LogicalSaveName.Length is >= 1 and <= 128
        && LogicalSaveName.StartsWith("GameBuddyPortfolio", StringComparison.Ordinal)
        && LogicalSaveName.All(IsAsciiSaveNameCharacter)
        && !LogicalSaveName.EndsWith("_", StringComparison.Ordinal)
        && IsObservedSaveSlotForLogicalName(ObservedSaveSlot, LogicalSaveName)
        && Path.IsPathFullyQualified(StartManifestPath)
        && IsValidEnvironmentVariableName(SigningKeyEnvironmentVariableName)
        && TimeoutSeconds is >= 30 and <= 900;

    private static bool IsObservedSaveSlotForLogicalName(string slot, string logicalName)
    {
        return slot.StartsWith(logicalName + "_", StringComparison.Ordinal)
            && slot.Length > logicalName.Length + 1
            && slot[(logicalName.Length + 1)..].All(char.IsDigit);
    }

    private static bool IsAsciiSaveNameCharacter(char character) =>
        character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-';

    private static bool IsValidEnvironmentVariableName(string value) =>
        value.Length is >= 1 and <= 128
        && value.All(character => character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_')
        && value[0] is not (>= '0' and <= '9');
}

public sealed class PortfolioBootstrapConfig
{
    public bool Enable { get; init; }
    public string SaveName { get; init; } = string.Empty;
    public string PlayerName { get; init; } = "GameBuddy";

    internal bool IsValid => Enable
        && SaveName.Length is >= 1 and <= 128
        && SaveName.StartsWith("GameBuddyPortfolio", StringComparison.Ordinal)
        && !SaveName.EndsWith("_", StringComparison.Ordinal)
        && SaveName.All(character => char.IsLetterOrDigit(character) || character is '_' or '-')
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
