using System.Security.Cryptography;
using System.Text.Json;

using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// Packed generation admission gate: builds the REAL canonical Host generation
/// (buildFixedReleaseProductionArtifactForTest, voice gateway enabled),
/// asserts the published generation carries a legal voice-gateway-admission
/// sidecar bound to the inventory, then drives VoiceLaunchCoordinator.Resolve
/// against that real generation directory with an accepted Host-owned
/// preference. Passing proves the cold path 构建打包 → 解压安装 → 启动准入
/// carries the Voice artifact end-to-end.
/// </summary>
public sealed class VoiceLaunchCoordinatorPackedGenerationTests
{
    [Fact]
    public async Task Resolve_admits_the_packed_voice_gateway_from_the_real_generation()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);

        // The published generation must carry the admission sidecar next to
        // the real bundled entry/protocol/ps1 files.
        var sidecarPath = Path.Combine(generation.GenerationRoot, "voice-gateway-admission.json");
        Assert.True(File.Exists(sidecarPath), "packed generation must publish voice-gateway-admission.json");
        using var sidecar = JsonDocument.Parse(await File.ReadAllTextAsync(sidecarPath));
        var entryPath = sidecar.RootElement.GetProperty("entryPath").GetString()
            ?? throw new InvalidOperationException("entryPath missing");
        var protocolPath = sidecar.RootElement.GetProperty("protocolPath").GetString()
            ?? throw new InvalidOperationException("protocolPath missing");
        var inventoryDigest = sidecar.RootElement.GetProperty("inventoryDigest").GetString()
            ?? throw new InvalidOperationException("inventoryDigest missing");
        Assert.Equal("gamebuddy-host-voice-gateway-admission/v1", sidecar.RootElement.GetProperty("schema").GetString());
        Assert.Equal(generation.GenerationId, sidecar.RootElement.GetProperty("generation").GetString());
        // The sidecar inventory digest must match the generation selection's:
        // the voice artifact is part of the immutable inventory, not an add-on.
        Assert.Equal(selection.InventoryDigest, inventoryDigest);
        Assert.True(File.Exists(Path.Combine(generation.GenerationRoot, entryPath)), "entry bundle must exist in the packed generation");
        Assert.True(File.Exists(Path.Combine(generation.GenerationRoot, protocolPath)), "protocol bundle must exist in the packed generation");

        // Drive the real coordinator: generation root, selection identity and
        // the Host-owned preference path under the data root.
        var preferencePath = Path.Combine(generation.LocalApplicationData, "GameBuddy", "data", "settings", "player-preference.json");
        Directory.CreateDirectory(Path.GetDirectoryName(preferencePath)!);
        WriteAcceptedPreference(preferencePath);

        var launch = VoiceLaunchCoordinator.Resolve(
            generation.GenerationRoot,
            generation.GenerationId,
            selection.InventoryDigest,
            preferencePath);

        Assert.NotNull(launch);
        Assert.InRange(launch.Port, 1, 65_535);
        Assert.Matches("^[A-Za-z0-9_-]{16,256}$", launch.Token);
        Assert.EndsWith("voice-gateway-entry.mjs", launch.Gateway.EntryPath, StringComparison.OrdinalIgnoreCase);
        Assert.EndsWith("voice-protocol-index.mjs", launch.Gateway.ProtocolPath, StringComparison.OrdinalIgnoreCase);
        // The admitted paths resolve to real files in the packed generation.
        Assert.True(File.Exists(Path.Combine(generation.GenerationRoot, launch.Gateway.EntryPath)));
        Assert.True(File.Exists(Path.Combine(generation.GenerationRoot, launch.Gateway.ProtocolPath)));

        // PowerShell helpers shipped next to the bundle (the entry's
        // ../windows-*.ps1 relative resolution) must be present in the pack.
        Assert.True(File.Exists(Path.Combine(generation.GenerationRoot, "voice-gateway", "windows-waveout.ps1")), "waveout helper must ship with the packed gateway");
        Assert.True(File.Exists(Path.Combine(generation.GenerationRoot, "voice-gateway", "windows-wavein.ps1")), "wavein helper must ship with the packed gateway");
    }

    [Fact]
    public async Task Resolve_declines_voice_when_the_real_generation_matches_but_consent_is_not_accepted()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);

        var preferencePath = Path.Combine(generation.LocalApplicationData, "GameBuddy", "data", "settings", "player-preference.json");
        Directory.CreateDirectory(Path.GetDirectoryName(preferencePath)!);
        // No preference file at all (undecided): must stay pure-text.
        Assert.Null(VoiceLaunchCoordinator.Resolve(generation.GenerationRoot, generation.GenerationId, selection.InventoryDigest, preferencePath));
        // Explic itly revoked keeps Voice off even with the artifact present.
        WritePreference(preferencePath, "revoked", null, 1);
        Assert.Null(VoiceLaunchCoordinator.Resolve(generation.GenerationRoot, generation.GenerationId, selection.InventoryDigest, preferencePath));
    }

    private static void WriteAcceptedPreference(string path, string? disclosureVersion = "mimo-cloud-tts-v1")
        => WritePreference(path, "accepted", disclosureVersion, 3);

    private static void WritePreference(string path, string consent, string? disclosureVersion, long revision)
    {
        var preference = new
        {
            schemaVersion = 1,
            revision,
            locale = (string?)null,
            disclosureVersion,
            consent,
            decidedAtMs = consent == "undecided" ? (long?)null : 1_700_000_000_000L,
            outputDevice = (string?)null,
        };
        File.WriteAllText(path, JsonSerializer.Serialize(preference));
    }

    private static string Digest(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}