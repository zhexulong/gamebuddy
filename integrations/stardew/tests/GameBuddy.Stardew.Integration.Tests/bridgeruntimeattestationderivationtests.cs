using FluentAssertions;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Pure derivation tests for ModEntry.TryCreateRuntimeAttestation. These
/// tests exercise the static helper with boolean topology flags and a nullable
/// environment variable string; they never depend on SMAPI, game state, or
/// ModEntry instance state.
/// </summary>
public sealed class BridgeRuntimeAttestationDerivationTests
{
    [Fact]
    public void FormalClient_WithValidGeneration_ReturnsFarmhandClient()
    {
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: true,
            nativeLocalFixture: false,
            launchGenerationEnvironmentVariable: "generation_01",
            out string? reasonCode);

        result.Should().NotBeNull();
        reasonCode.Should().BeNull();
        result!.RuntimeRole.Should().Be("farmhand_client");
        result.LaunchGeneration.Should().Be("generation_01");
    }

    [Fact]
    public void FormalClient_WithMissingGeneration_ReturnsNull()
    {
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: true,
            nativeLocalFixture: false,
            launchGenerationEnvironmentVariable: null,
            out string? reasonCode);

        result.Should().BeNull();
        reasonCode.Should().Be("launch_generation_unavailable");
    }

    [Fact]
    public void FormalClient_WithBlankGeneration_ReturnsNull()
    {
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: true,
            nativeLocalFixture: false,
            launchGenerationEnvironmentVariable: string.Empty,
            out string? reasonCode);

        result.Should().BeNull();
        reasonCode.Should().Be("launch_generation_unavailable");
    }

    [Fact]
    public void FormalClient_WithInvalidNonOpaqueGeneration_ReturnsNull()
    {
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: true,
            nativeLocalFixture: false,
            launchGenerationEnvironmentVariable: "spaces and symbols !!!",
            out string? reasonCode);

        result.Should().BeNull();
        reasonCode.Should().Be("launch_generation_unavailable");
    }

    [Fact]
    public void FormalClient_WithOversizedGeneration_ReturnsNull()
    {
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: true,
            nativeLocalFixture: false,
            launchGenerationEnvironmentVariable: new string('a', 129),
            out string? reasonCode);

        result.Should().BeNull();
        reasonCode.Should().Be("launch_generation_unavailable");
    }

    [Fact]
    public void NativeLocalFixture_WithContaminatingEnv_ReturnsNativeLocalFixtureAndNullGeneration()
    {
        // Even if the env variable happens to be set (e.g. from a prior
        // launcher invocation), a native-local fixture topology must ignore
        // it and produce null generation.
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: false,
            nativeLocalFixture: true,
            launchGenerationEnvironmentVariable: "contaminating_generation",
            out string? reasonCode);

        result.Should().NotBeNull();
        reasonCode.Should().BeNull();
        result!.RuntimeRole.Should().Be("native_local_fixture");
        result.LaunchGeneration.Should().BeNull();
    }

    [Fact]
    public void NativeLocalFixture_WithNullEnv_ReturnsNativeLocalFixtureAndNullGeneration()
    {
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: false,
            nativeLocalFixture: true,
            launchGenerationEnvironmentVariable: null,
            out string? reasonCode);

        result.Should().NotBeNull();
        reasonCode.Should().BeNull();
        result!.RuntimeRole.Should().Be("native_local_fixture");
        result.LaunchGeneration.Should().BeNull();
    }

    [Fact]
    public void Unattested_WithContaminatingEnv_ReturnsUnattestedAndNullGeneration()
    {
        // Legacy or unattested bridge topologies must ignore any env
        // variable and produce null generation.
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: false,
            nativeLocalFixture: false,
            launchGenerationEnvironmentVariable: "contaminating_generation",
            out string? reasonCode);

        result.Should().NotBeNull();
        reasonCode.Should().BeNull();
        result!.RuntimeRole.Should().Be("unattested");
        result.LaunchGeneration.Should().BeNull();
    }

    [Fact]
    public void Unattested_WithNullEnv_ReturnsUnattestedAndNullGeneration()
    {
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: false,
            nativeLocalFixture: false,
            launchGenerationEnvironmentVariable: null,
            out string? reasonCode);

        result.Should().NotBeNull();
        reasonCode.Should().BeNull();
        result!.RuntimeRole.Should().Be("unattested");
        result.LaunchGeneration.Should().BeNull();
    }

    [Fact]
    public void ContradictoryBooleans_ReturnsNull()
    {
        BridgeRuntimeAttestation? result = ModEntry.TryCreateRuntimeAttestation(
            formalClientConfigured: true,
            nativeLocalFixture: true,
            launchGenerationEnvironmentVariable: null,
            out string? reasonCode);

        result.Should().BeNull();
        reasonCode.Should().Be("contradictory_topology_booleans");
    }
}