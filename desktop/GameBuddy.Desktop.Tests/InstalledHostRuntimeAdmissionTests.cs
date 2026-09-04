using GameBuddy.Desktop.Tests.Fixtures;
using System.Security.Cryptography;
using System.Text.Json;

namespace GameBuddy.Desktop.Tests;

public sealed class InstalledHostRuntimeAdmissionTests
{
    [Fact]
    public async Task Selection_rejects_sidecar_digest_mismatch()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await WritePointerAsync(generation, runtimeAdmissionSha256: new string('0', 64));

        Assert.Throws<GuardianLaunchUnavailableException>(() => InstalledGenerationSelection.Acquire(generation.ProgramRoot));
    }

    [Fact]
    public void Runtime_admission_consumes_the_selection_frozen_sidecar_bytes_without_rereading_the_sidecar()
    {
        var selectionSource = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "InstalledGenerationSelection.cs")));
        var admissionSource = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "InstalledHostRuntimeAdmission.cs")));

        Assert.Contains("var runtimeAdmissionBytes = File.ReadAllBytes(InstalledGenerationPaths.ChildFile(generationRoot, \"host-runtime-admission.json\"));", selectionSource, StringComparison.Ordinal);
        Assert.Contains("Digest(runtimeAdmissionBytes), runtimeAdmissionSha256", selectionSource, StringComparison.Ordinal);
        Assert.Contains("var bytes = selection.RuntimeAdmissionBytesCopy();", admissionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("File.ReadAllBytes", admissionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("ChildFile(selection.GenerationRoot, \"host-runtime-admission.json\")", admissionSource, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Selection_sidecar_copies_cannot_mutate_the_frozen_admission_input()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);

        var first = selection.RuntimeAdmissionBytesCopy();
        var expected = first[0];
        first[0] ^= 0xff;

        var later = selection.RuntimeAdmissionBytesCopy();
        Assert.Equal(expected, later[0]);
        Assert.NotEqual(first[0], later[0]);
        using var sidecar = JsonDocument.Parse(later);
        Assert.Equal("host-runtime-admission/v1", sidecar.RootElement.GetProperty("schema").GetString());
    }

    [Fact]
    public void Selection_source_does_not_expose_its_runtime_admission_backing_array()
    {
        var source = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "InstalledGenerationSelection.cs")));

        Assert.Contains("private readonly byte[] runtimeAdmissionBytes;", source, StringComparison.Ordinal);
        Assert.Contains("internal byte[] RuntimeAdmissionBytesCopy() => (byte[])runtimeAdmissionBytes.Clone();", source, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadOnlyMemory<byte> RuntimeAdmissionBytes", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Selection_rejects_legacy_or_malformed_pointer()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await File.WriteAllTextAsync(generation.CurrentPointerPath, $"{{\"schema\":\"gamebuddy-host-production-current/v1\",\"generation\":\"{generation.GenerationId}\",\"inventoryDigest\":\"{new string('a', 64)}\"}}");

        Assert.Throws<GuardianLaunchUnavailableException>(() => InstalledGenerationSelection.Acquire(generation.ProgramRoot));
    }

    [Fact]
    public async Task Guardian_and_runtime_use_the_same_frozen_generation_selection()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);

        new InstalledHostRuntimeAdmission().Admit(selection);
        await using var image = await new InstalledGenerationAdmission(generation.ProgramRoot).AdmitGuardianAsync(selection, CancellationToken.None);
        Assert.Equal(generation.GenerationId, image.GenerationId);
    }

    [Fact]
    public async Task Admit_rejects_runtime_or_bootstrap_tamper()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var bootstrap = Path.Combine(generation.GenerationRoot, "desktop-runtime-bootstrap.internal.js");
        await File.AppendAllTextAsync(bootstrap, "tamper");
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
        Assert.Throws<GuardianLaunchUnavailableException>(() => new InstalledHostRuntimeAdmission().Admit(selection));
    }

    private static async Task WritePointerAsync(DisposableInstalledGuardianGeneration generation, string? runtimeAdmissionSha256 = null)
    {
        var sidecar = await File.ReadAllBytesAsync(Path.Combine(generation.GenerationRoot, "host-runtime-admission.json"));
        using var inventory = JsonDocument.Parse(await File.ReadAllBytesAsync(Path.Combine(generation.GenerationRoot, "production-inventory.json")));
        var digest = Convert.ToHexString(SHA256.HashData(sidecar)).ToLowerInvariant();
        await File.WriteAllTextAsync(generation.CurrentPointerPath, JsonSerializer.Serialize(new
        {
            schema = "gamebuddy-host-production-current/v2",
            generation = generation.GenerationId,
            inventoryDigest = inventory.RootElement.GetProperty("digest").GetString(),
            runtimeAdmissionSha256 = runtimeAdmissionSha256 ?? digest,
        }) + "\n");
    }
}
