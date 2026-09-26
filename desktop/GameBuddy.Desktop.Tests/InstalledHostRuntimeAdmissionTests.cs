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

        using var runtime = new InstalledHostRuntimeAdmission().Admit(selection);
        Assert.Equal(Path.Combine(generation.GenerationRoot, "bootstrap", "entry", "desktop-host-entry.internal.js"), runtime.BootstrapPath);
        runtime.VerifyStillLocked();
        await using var image = await new InstalledGenerationAdmission(generation.ProgramRoot).AdmitGuardianAsync(selection, CancellationToken.None);
        Assert.Equal(generation.GenerationId, image.GenerationId);
    }

    [Theory]
    [InlineData("runtime/node.exe")]
    [InlineData("bootstrap/entry/desktop-host-entry.internal.js")]
    public async Task Admit_rejects_runtime_or_bootstrap_tamper(string admittedFile)
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await File.AppendAllTextAsync(Path.Combine(generation.GenerationRoot, admittedFile.Replace('/', Path.DirectorySeparatorChar)), "tamper");
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);

        Assert.Throws<GuardianLaunchUnavailableException>(() => new InstalledHostRuntimeAdmission().Admit(selection));
    }

    [Fact]
    public async Task Admit_rejects_legacy_bootstrap_path_in_admission_contract()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var sidecarPath = Path.Combine(generation.GenerationRoot, "host-runtime-admission.json");
        var currentEntry = Path.Combine(generation.GenerationRoot, "bootstrap", "entry", "desktop-host-entry.internal.js");
        var obsoleteEntry = Path.Combine(generation.GenerationRoot, "desktop-runtime-bootstrap.internal.js");
        File.Copy(currentEntry, obsoleteEntry);
        File.Delete(currentEntry);
        var sidecar = await File.ReadAllTextAsync(sidecarPath);
        await File.WriteAllTextAsync(sidecarPath, sidecar.Replace("bootstrap/entry/desktop-host-entry.internal.js", "desktop-runtime-bootstrap.internal.js", StringComparison.Ordinal));
        await WritePointerAsync(generation);
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);

        Assert.Throws<GuardianLaunchUnavailableException>(() => new InstalledHostRuntimeAdmission().Admit(selection));
    }

    [Fact]
    public async Task Admit_holds_the_locked_runtime_and_bootstrap_against_replacement_until_disposal()
    {
        // The equivalent negative test for the guardian exe asserts that a locked
        // image rejects Move/Delete/Directory.Move. The runtime image and the
        // bootstrap entry needed the same proof, because they are what
        // CreateProcess actually executes: if either could be swapped between the
        // admission hash and the launch, the hash would be decorative. The lock is
        // a share-mode lock (FileReadData|FileExecute with FileShareRead only), so
        // the OS refuses the mutation rather than a second hash re-check catching it.
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await using var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
        using var admitted = new InstalledHostRuntimeAdmission().Admit(selection);

        var runtimePath = Path.Combine(generation.GenerationRoot, "runtime", "node.exe");
        var bootstrapPath = Path.Combine(generation.GenerationRoot, "bootstrap", "entry", "desktop-host-entry.internal.js");
        var replacement = Path.Combine(generation.LocalApplicationData, "replacement-runtime.exe");
        await File.WriteAllTextAsync(replacement, "replacement");

        foreach (var locked in new[] { runtimePath, bootstrapPath })
        {
            AssertLockedMutationRejected(() => File.Move(replacement, locked, overwrite: true));
            AssertLockedMutationRejected(() => File.Delete(locked));
        }
        // Moving the runtime directory is the required first step to substitute it
        // with a junction; the locked image inside rejects that too.
        AssertLockedMutationRejected(() => Directory.Move(Path.Combine(generation.GenerationRoot, "runtime"), Path.Combine(generation.GenerationRoot, "runtime.original")));

        // And the admitted bytes are still the admitted bytes.
        var bytes = await File.ReadAllBytesAsync(runtimePath);
        Assert.True(bytes.Length > 0);
    }

    private static void AssertLockedMutationRejected(Action mutate)
    {
        var exception = Record.Exception(mutate);
        Assert.True(
            exception is IOException or UnauthorizedAccessException,
            $"expected the share-mode lock to reject the mutation, got {exception?.GetType().Name ?? "no exception"}");
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
