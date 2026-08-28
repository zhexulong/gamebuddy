using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Bounded repair slice: ordinary Farmhand Host/client provisioning
/// configuration no longer carries the certified game/build/SMAPI tuple, so
/// its admission cannot be constrained by that removed exact runtime tuple.
/// The independent NativeChatIngressPolicy exact runtime gate still rejects
/// the same drift, so the two surfaces remain distinct.
/// </summary>
public sealed class ProvisioningConfigCompatibilityTests
{
    private static readonly string[] RemovedRuntimeTuplePropertyNames =
    {
        "ExpectedGameVersion",
        "ExpectedGameBuildNumber",
        "ExpectedSmapiVersion",
    };

    private static readonly string[] HostAuthorityPropertyNames =
    {
        "Endpoint",
        "ExpectedGameVersion",
        "ExpectedGameBuildNumber",
        "ExpectedSmapiVersion",
    };

    [Fact]
    public void HostProvisioningConfig_ProducerValidSurface_HasNoRemovedRuntimeTupleToConstrainIsValid()
    {
        var config = new HostFarmhandProvisioningConfig
        {
            Enable = true,
            SessionDirectory = Path.GetTempPath(),
            SessionToken = "host_provisioning_token_0123456789abcdef",
            IntegrationVersion = "0.1.0",
            FarmhandName = "GameBuddy",
            ManifestLifetimeSeconds = 120,
            AuthorizedCompanionIds = new List<string> { "companion_opaque_01" },
        };

        // Consumer: a structurally valid Host provisioning config is admitted.
        config.IsValid.Should().BeTrue();

        // Endpoint and the removed exact runtime tuple can no longer constrain
        // admission: neither native authority is caller-configurable.
        PublicPropertiesNamed<HostFarmhandProvisioningConfig>(HostAuthorityPropertyNames).Should().BeEmpty();
    }

    [Fact]
    public void ProvisionerConfig_ProducerValidSurface_HasNoRemovedRuntimeTupleToConstrainIsValid()
    {
        var config = new FarmhandProvisionerConfig
        {
            Enable = true,
            ManifestPath = Path.Combine(Path.GetTempPath(), "stardew-farmhand-manifest.json"),
            SessionToken = "provisioner_token_0123456789abcdef",
            IntegrationVersion = "0.1.0",
            TimeoutSeconds = 45,
        };

        config.IsValid.Should().BeTrue();
        PublicPropertiesNamed<FarmhandProvisionerConfig>(RemovedRuntimeTuplePropertyNames).Should().BeEmpty();
    }

    [Fact]
    public void NativeChatIngressPolicy_Verifier_StillRejectsDriftedRuntimeIndependently()
    {
        // The ingress policy still pins the exact certified runtime triple.
        NativeChatIngressPolicy.IsSupportedRuntime(
            NativeChatIngressPolicy.SupportedGameVersion,
            NativeChatIngressPolicy.SupportedGameBuildNumber,
            NativeChatIngressPolicy.SupportedSmapiVersion).Should().BeTrue();

        // Deliberate drift: move every component away from the pinned triple,
        // exactly the drift the removed provisioning tuple used to reject.
        const string driftedGameVersion = "1.6.16";
        const int driftedGameBuildNumber = 24357;
        const string driftedSmapiVersion = "4.5.3";

        // Guard: the drift values must actually differ from today's pins,
        // otherwise the assertions below silently lose their meaning.
        NativeChatIngressPolicy.SupportedGameVersion.Should().NotBe(driftedGameVersion);
        NativeChatIngressPolicy.SupportedGameBuildNumber.Should().NotBe(driftedGameBuildNumber);
        NativeChatIngressPolicy.SupportedSmapiVersion.Should().NotBe(driftedSmapiVersion);

        // Whole-triple drift and each single-component drift fail closed.
        NativeChatIngressPolicy.IsSupportedRuntime(driftedGameVersion, driftedGameBuildNumber, driftedSmapiVersion).Should().BeFalse();
        NativeChatIngressPolicy.IsSupportedRuntime(driftedGameVersion, NativeChatIngressPolicy.SupportedGameBuildNumber, NativeChatIngressPolicy.SupportedSmapiVersion).Should().BeFalse();
        NativeChatIngressPolicy.IsSupportedRuntime(NativeChatIngressPolicy.SupportedGameVersion, driftedGameBuildNumber, NativeChatIngressPolicy.SupportedSmapiVersion).Should().BeFalse();
        NativeChatIngressPolicy.IsSupportedRuntime(NativeChatIngressPolicy.SupportedGameVersion, NativeChatIngressPolicy.SupportedGameBuildNumber, driftedSmapiVersion).Should().BeFalse();
    }

    private static string[] PublicPropertiesNamed<T>(IReadOnlyCollection<string> names) =>
        typeof(T).GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(property => property.Name)
            .Where(name => names.Contains(name, StringComparer.Ordinal))
            .ToArray();
}
