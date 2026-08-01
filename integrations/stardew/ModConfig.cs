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

    /// <summary>Player-controlled local allowlist for verified Game Actions. Empty means no actions are enabled.</summary>
    public List<string> EnabledActions { get; init; } = new();

    internal IReadOnlySet<string> EnabledActionSet => new HashSet<string>(EnabledActions.Where(action => action is "move_to_tile" or "equip_tool"), StringComparer.Ordinal);

    internal bool HasValidLocalBridgeConfiguration => EnableLocalBridge
        && BridgeProtocol.IsOpaqueId(PipeName)
        && BridgeToken.Length is >= 16 and <= 256
        && new BridgeScope("stardew", SaveId, WorldId, PlayerId, CompanionId).IsValid;
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
        && TimeoutSeconds is >= 1 and <= 60;
}

/// <summary>Unprivileged, title-screen-only native LAN handshake diagnostic.</summary>
public sealed class HostAutomationConfig
{
    public bool Enable { get; init; }
    public string SaveName { get; init; } = string.Empty;
    public int TimeoutSeconds { get; init; } = 90;
    public bool TriggerNativeSaveAfterAttachment { get; init; }
    public bool TriggerNativeSaveAfterClientExit { get; init; }

    internal bool IsValid => Enable
        && SaveName.Length is >= 1 and <= 128
        && SaveName.EndsWith("_", StringComparison.Ordinal) is false
        && SaveName.All(character => char.IsLetterOrDigit(character) || character is '_' or '-');
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
