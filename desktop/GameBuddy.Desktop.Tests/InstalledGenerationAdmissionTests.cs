using GameBuddy.Desktop.Tests.Fixtures;
using System.Security.Cryptography;
using System.Text.Json;

namespace GameBuddy.Desktop.Tests;

public sealed class InstalledGenerationAdmissionTests
{
    [Fact]
    public async Task AdmitGuardian_rejects_inventory_tamper_before_native_handle_open()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await File.WriteAllTextAsync(generation.CurrentPointerPath, $"{{\"schema\":\"gamebuddy-host-production-current/v1\",\"generation\":\"{generation.GenerationId}\",\"inventoryDigest\":\"0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}");
        var admission = new InstalledGenerationAdmission(generation.ProgramRoot);

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => admission.AdmitGuardianAsync(CancellationToken.None));
    }

    [Fact]
    public async Task AdmitGuardian_accepts_the_exact_host_published_admission_contract()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var admission = new InstalledGenerationAdmission(generation.ProgramRoot);

        await using var image = await admission.AdmitGuardianAsync(CancellationToken.None);

        Assert.Equal(Path.GetFullPath(generation.GuardianExePath), image.VerifiedAbsolutePath, ignoreCase: true);
    }

    [Theory]
    [InlineData("not-json")]
    [InlineData("{\"schema\":\"foreign/v1\"}")]
    public async Task AdmitGuardian_rejects_malformed_or_foreign_host_admission_contract(string contract)
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var admissionPath = Path.Combine(generation.GenerationRoot, "guardian-admission.json");
        await File.WriteAllTextAsync(admissionPath, contract);

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => new InstalledGenerationAdmission(generation.ProgramRoot).AdmitGuardianAsync(CancellationToken.None));
    }

    [Fact]
    public async Task AdmitGuardian_rejects_self_consistent_foreign_pair_contract()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var admissionPath = Path.Combine(generation.GenerationRoot, "guardian-admission.json");
        var contract = await File.ReadAllTextAsync(admissionPath);
        contract = contract
            .Replace("native/windows-stardew-bootstrap-guardian/win-x64/GameBuddy.WindowsStardewBootstrapGuardian.exe", "foreign/ForeignGuardian.exe", StringComparison.Ordinal)
            .Replace("native/windows-stardew-bootstrap-guardian/win-x64/windows-stardew-bootstrap-guardian.manifest.json", "foreign/foreign.manifest.json", StringComparison.Ordinal)
            .Replace("GameBuddy.WindowsStardewBootstrapGuardian.exe", "ForeignGuardian.exe", StringComparison.Ordinal);
        await File.WriteAllTextAsync(admissionPath, contract);

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => new InstalledGenerationAdmission(generation.ProgramRoot).AdmitGuardianAsync(CancellationToken.None));
    }

    [Fact]
    public async Task AdmitGuardian_rejects_pair_replacement_before_native_handle_open()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        await File.WriteAllTextAsync(generation.GuardianExePath, "replacement");
        var admission = new InstalledGenerationAdmission(generation.ProgramRoot);

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => admission.AdmitGuardianAsync(CancellationToken.None));
    }

    [Fact]
    public async Task AdmitGuardian_rejects_replace_or_reparse_attempt_after_lock_before_handle_hash_and_retains_original_image()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var expectedDigest = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(generation.GuardianExePath))).ToLowerInvariant();
        var replacement = Path.Combine(generation.LocalApplicationData, "replacement.exe");
        await File.WriteAllTextAsync(replacement, "replacement");
        var admission = new InstalledGenerationAdmission(generation.ProgramRoot);
        var barrierReached = false;
        admission.AfterGuardianLockBeforeHashForTesting = () =>
        {
            barrierReached = true;
            AssertLockedMutationRejected(() => File.Move(replacement, generation.GuardianExePath, overwrite: true));
            AssertLockedMutationRejected(() => File.Delete(generation.GuardianExePath));
            // Moving the pair root is the required first step to replace it with a
            // junction/reparse target; the locked image rejects that substitution.
            AssertLockedMutationRejected(() => Directory.Move(generation.GuardianPairRoot, generation.GuardianPairRoot + ".original"));
        };

        await using var image = await admission.AdmitGuardianAsync(CancellationToken.None);
        var identity = default(WindowsNative.ByHandleFileInformation);
        Assert.True(WindowsNative.GetFileInformationByHandle(image.ExecutableHandle, out identity));
        var bytes = new byte[checked((int)identity.FileSizeLow)];
        Assert.Equal(bytes.Length, RandomAccess.Read(image.ExecutableHandle, bytes, 0));

        Assert.True(barrierReached);
        Assert.Equal(expectedDigest, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        image.VerifyStillLockedForCreate();
    }

    [Fact]
    public async Task AdmitGuardian_disposes_locked_handle_when_post_lock_admission_fails()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        var admission = new InstalledGenerationAdmission(generation.ProgramRoot)
        {
            AfterGuardianLockBeforeHashForTesting = () => throw new IOException("test post-lock failure"),
        };

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => admission.AdmitGuardianAsync(CancellationToken.None));
        File.Delete(generation.GuardianExePath);
        Assert.False(File.Exists(generation.GuardianExePath));
    }

    private static void AssertLockedMutationRejected(Action attempt)
    {
        var exception = Record.Exception(attempt);
        Assert.True(exception is IOException or UnauthorizedAccessException, $"Expected a locked-file rejection, got {exception?.GetType().FullName ?? "no exception"}.");
    }

    [Fact]
    public async Task AdmitGuardian_rejects_generations_junction_to_self_consistent_host_wire_tree_before_native_handle_open()
    {
        await using var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        generation.ReplaceGenerationsWithJunction();
        var admission = new InstalledGenerationAdmission(generation.ProgramRoot);

        await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(() => admission.AdmitGuardianAsync(CancellationToken.None));
    }
}
