using GameBuddy.Stardew.Core.Protocol;

namespace GameBuddy.Stardew;

/// <summary>
/// Immutable runtime identity attached to a bridge session. Formal AI Farmhand
/// clients must carry the launcher-provided generation; native-local fixtures
/// and unattested sessions intentionally carry no generation.
/// </summary>
internal sealed record BridgeRuntimeAttestation
{
    private static readonly BridgeRuntimeAttestation DefaultValue = new("unattested", null);

    public string RuntimeRole { get; }

    public string? LaunchGeneration { get; }

    public static BridgeRuntimeAttestation Default => DefaultValue;

    public BridgeRuntimeAttestation(string runtimeRole, string? launchGeneration)
    {
        bool isValid = runtimeRole switch
        {
            "farmhand_client" => launchGeneration is not null && BridgeProtocol.IsOpaqueId(launchGeneration),
            "native_local_fixture" or "unattested" => launchGeneration is null,
            _ => false,
        };

        if (!isValid)
            throw new ArgumentException("Invalid bridge runtime attestation pair.", nameof(runtimeRole));

        this.RuntimeRole = runtimeRole;
        this.LaunchGeneration = launchGeneration;
    }
}
