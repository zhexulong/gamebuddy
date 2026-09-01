using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

internal sealed class AdmittedGuardianImage : IDisposable, IAsyncDisposable
{
    private readonly WindowsNative.ByHandleFileInformation identity;
    private bool disposed;

    internal AdmittedGuardianImage(SafeFileHandle executableHandle, string verifiedAbsolutePath, string generationId, WindowsNative.ByHandleFileInformation identity)
    {
        ExecutableHandle = executableHandle;
        VerifiedAbsolutePath = verifiedAbsolutePath;
        GenerationId = generationId;
        this.identity = identity;
    }

    internal SafeFileHandle ExecutableHandle { get; }
    internal string VerifiedAbsolutePath { get; }
    internal string GenerationId { get; }

    internal void VerifyStillLockedForCreate()
    {
        if (disposed || ExecutableHandle.IsInvalid || !WindowsNative.GetFileInformationByHandle(ExecutableHandle, out var current) ||
            current.VolumeSerialNumber != identity.VolumeSerialNumber || current.FileIndexHigh != identity.FileIndexHigh || current.FileIndexLow != identity.FileIndexLow ||
            (current.FileAttributes & (uint)FileAttributes.ReparsePoint) != 0)
        {
            throw new GuardianLaunchUnavailableException();
        }

        var finalPath = GetFinalPath(ExecutableHandle);
        if (!StringComparer.OrdinalIgnoreCase.Equals(finalPath, NormalizeFinalPath(VerifiedAbsolutePath)))
        {
            throw new GuardianLaunchUnavailableException();
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        ExecutableHandle.Dispose();
    }

    public ValueTask DisposeAsync()
    {
        Dispose();
        return ValueTask.CompletedTask;
    }

    private static string GetFinalPath(SafeFileHandle handle)
    {
        var buffer = new char[32768];
        var length = WindowsNative.GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Length, 0);
        if (length == 0 || length >= buffer.Length) throw new GuardianLaunchUnavailableException();
        return NormalizeFinalPath(new string(buffer, 0, (int)length));
    }

    private static string NormalizeFinalPath(string path) => path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path[4..] : path;
}

internal sealed class InstalledGenerationAdmission
{
    private const string PointerSchema = "gamebuddy-host-production-current/v1";
    private const string InventorySchema = "gamebuddy-host-production-inventory/v4";
    private const string GuardianAdmissionSchema = "gamebuddy-host-guardian-admission/v1";
    private const string GuardianHelperPath = "native/windows-stardew-bootstrap-guardian/win-x64/GameBuddy.WindowsStardewBootstrapGuardian.exe";
    private const string GuardianManifestPath = "native/windows-stardew-bootstrap-guardian/win-x64/windows-stardew-bootstrap-guardian.manifest.json";
    private const string GuardianHelperFileName = "GameBuddy.WindowsStardewBootstrapGuardian.exe";
    private const string GuardianAdmission = "guardian-admission.json";
    private readonly string? fixtureProgramRoot;

    // Test-only hook; production entrypoints neither set nor expose it.
    internal Action? AfterGuardianLockBeforeHashForTesting { get; set; }

    internal InstalledGenerationAdmission() { }
    internal InstalledGenerationAdmission(string fixtureProgramRoot) => this.fixtureProgramRoot = CanonicalDirectory(fixtureProgramRoot);
    internal InstalledGenerationAdmission(CurrentUserRootLayout fixtureLayout) => fixtureProgramRoot = CanonicalDirectory((fixtureLayout ?? throw new ArgumentNullException(nameof(fixtureLayout))).ProgramRoot);

    internal Task<AdmittedGuardianImage> AdmitGuardianAsync(CancellationToken cancellationToken) => Task.FromResult(Admit(cancellationToken));

    internal static InstalledGenerationAdmission FromCurrentUserRegistration() => new();

    private AdmittedGuardianImage Admit(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            var programRoot = fixtureProgramRoot ?? CurrentUserRootLayout.DeriveForCurrentUser().ProgramRoot;
            EnsureOrdinaryDirectory(programRoot);
            var pointerPath = ChildFile(programRoot, "current.json");
            using var pointer = ParseDocument(pointerPath);
            var pointerRoot = pointer.RootElement;
            if (!ExactProperties(pointerRoot, "schema", "generation", "inventoryDigest") || pointerRoot.GetProperty("schema").GetString() != PointerSchema ||
                !ValidGeneration(pointerRoot.GetProperty("generation").GetString()) || !ValidDigest(pointerRoot.GetProperty("inventoryDigest").GetString())) throw new GuardianLaunchUnavailableException();
            var generation = pointerRoot.GetProperty("generation").GetString()!;
            var generationRoot = ChildDirectory(ChildDirectory(programRoot, "generations"), generation);
            var pointerDigest = pointerRoot.GetProperty("inventoryDigest").GetString()!;
            var inventoryPath = ChildFile(generationRoot, "production-inventory.json");
            using var inventory = ParseDocument(inventoryPath);
            VerifyInventoryDigest(inventory.RootElement, pointerDigest);
            using var admission = ParseDocument(ChildFile(generationRoot, GuardianAdmission));
            var contract = ParseGuardianAdmission(admission.RootElement, pointerDigest);

            var exePath = ChildFile(generationRoot, contract.HelperPath.Replace('/', Path.DirectorySeparatorChar));
            var manifestPath = ChildFile(generationRoot, contract.ManifestPath.Replace('/', Path.DirectorySeparatorChar));
            if (!DigestFile(manifestPath).Equals(contract.ManifestSha256, StringComparison.Ordinal)) throw new GuardianLaunchUnavailableException();
            var expectedManifest = $"{{\"schemaVersion\":{contract.ManifestSchemaVersion},\"protocolVersion\":{contract.ManifestProtocolVersion},\"rid\":\"{contract.ManifestRid}\",\"helperFileName\":\"{contract.ManifestHelperFileName}\",\"sha256\":\"{contract.HelperSha256}\"}}\n";
            if (!StringComparer.Ordinal.Equals(File.ReadAllText(manifestPath, Encoding.UTF8), expectedManifest)) throw new GuardianLaunchUnavailableException();

            // Lock the image before any content verification. The same non-write,
            // non-delete shared handle is retained until CreateProcess completes.
            var handle = WindowsNative.CreateFile(WindowsNative.ToExtendedLengthPath(exePath), WindowsNative.FileReadData | WindowsNative.FileExecute, WindowsNative.FileShareRead, IntPtr.Zero, WindowsNative.OpenExisting, WindowsNative.FileAttributeNormal, IntPtr.Zero);
            if (handle.IsInvalid) WindowsNative.ThrowLastError("guardian_launch_unavailable");
            try
            {
                if (!WindowsNative.GetFileInformationByHandle(handle, out var identity) || (identity.FileAttributes & (uint)FileAttributes.ReparsePoint) != 0) throw new GuardianLaunchUnavailableException();
                var image = new AdmittedGuardianImage(handle, exePath, generation, identity);
                image.VerifyStillLockedForCreate();
                AfterGuardianLockBeforeHashForTesting?.Invoke();
                image.VerifyStillLockedForCreate();
                if (!DigestHandle(handle, identity).Equals(contract.HelperSha256, StringComparison.Ordinal)) throw new GuardianLaunchUnavailableException();
                image.VerifyStillLockedForCreate();
                return image;
            }
            catch { handle.Dispose(); throw; }
        }
        catch (GuardianLaunchUnavailableException) { throw; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or CryptographicException)
        {
            throw new GuardianLaunchUnavailableException(innerException: exception);
        }
    }

    private static void VerifyInventoryDigest(JsonElement inventory, string pointerDigest)
    {
        if (!ExactProperties(inventory, "schema", "entries", "externalRuntimeClosure", "digest") || inventory.GetProperty("schema").GetString() != InventorySchema ||
            !ValidDigest(inventory.GetProperty("digest").GetString()) || !StringComparer.Ordinal.Equals(inventory.GetProperty("digest").GetString(), pointerDigest))
            throw new GuardianLaunchUnavailableException();
    }

    private static GuardianAdmissionContract ParseGuardianAdmission(JsonElement value, string pointerDigest)
    {
        if (!ExactProperties(value, "schema", "inventoryDigest", "helperPath", "manifestPath", "helperSha256", "manifestSha256", "manifestSchemaVersion", "manifestProtocolVersion", "manifestRid", "manifestHelperFileName") ||
            value.GetProperty("schema").GetString() != GuardianAdmissionSchema ||
            !ValidDigest(value.GetProperty("inventoryDigest").GetString()) || !StringComparer.Ordinal.Equals(value.GetProperty("inventoryDigest").GetString(), pointerDigest) ||
            !ValidRelativeFile(value.GetProperty("helperPath").GetString()) || !ValidRelativeFile(value.GetProperty("manifestPath").GetString()) ||
            value.GetProperty("helperPath").GetString() != GuardianHelperPath || value.GetProperty("manifestPath").GetString() != GuardianManifestPath ||
            !ValidDigest(value.GetProperty("helperSha256").GetString()) || !ValidDigest(value.GetProperty("manifestSha256").GetString()) ||
            value.GetProperty("manifestSchemaVersion").GetInt32() != 1 || value.GetProperty("manifestProtocolVersion").GetInt32() != 1 ||
            value.GetProperty("manifestRid").GetString() != "win-x64" || value.GetProperty("manifestHelperFileName").GetString() != GuardianHelperFileName)
            throw new GuardianLaunchUnavailableException();
        return new GuardianAdmissionContract(value.GetProperty("helperPath").GetString()!, value.GetProperty("manifestPath").GetString()!, value.GetProperty("helperSha256").GetString()!, value.GetProperty("manifestSha256").GetString()!, value.GetProperty("manifestSchemaVersion").GetInt32(), value.GetProperty("manifestProtocolVersion").GetInt32(), value.GetProperty("manifestRid").GetString()!, value.GetProperty("manifestHelperFileName").GetString()!);
    }

    private sealed record GuardianAdmissionContract(string HelperPath, string ManifestPath, string HelperSha256, string ManifestSha256, int ManifestSchemaVersion, int ManifestProtocolVersion, string ManifestRid, string ManifestHelperFileName);

    private static JsonDocument ParseDocument(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new GuardianLaunchUnavailableException();
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }

    private static string ChildDirectory(string root, string relative)
    {
        var target = Path.GetFullPath(Path.Combine(root, relative));
        if (!IsInside(root, target)) throw new GuardianLaunchUnavailableException();
        EnsureOrdinaryAncestors(root, target);
        EnsureOrdinaryDirectory(target);
        return target;
    }

    private static string ChildFile(string root, string relative)
    {
        var target = Path.GetFullPath(Path.Combine(root, relative));
        if (!IsInside(root, target)) throw new GuardianLaunchUnavailableException();
        EnsureOrdinaryAncestors(root, target);
        if (!File.Exists(target) || (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0) throw new GuardianLaunchUnavailableException();
        return target;
    }

    private static void EnsureOrdinaryAncestors(string root, string target)
    {
        EnsureOrdinaryDirectory(root);
        var relative = Path.GetRelativePath(root, target);
        if (Path.IsPathFullyQualified(relative) || relative == ".." || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)) throw new GuardianLaunchUnavailableException();
        var current = root;
        var segments = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        for (var index = 0; index < segments.Length - 1; index++)
        {
            if (string.IsNullOrEmpty(segments[index])) continue;
            current = Path.Combine(current, segments[index]);
            EnsureOrdinaryDirectory(current);
        }
    }

    private static bool IsInside(string root, string candidate) => candidate.StartsWith(Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    private static void EnsureOrdinaryDirectory(string path) { if (!Directory.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new GuardianLaunchUnavailableException(); }
    private static string CanonicalDirectory(string path) { var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)); EnsureOrdinaryDirectory(canonical); return canonical; }
    // This is the exact generation spelling emitted by Host's canonical
    // publishProductionArtifact authority: g-<base36 time>-<pid>-<uuid hex>.
    private static bool ValidGeneration(string? value) => value is not null && System.Text.RegularExpressions.Regex.IsMatch(value, "^g-[0-9a-z]+-[0-9]+-[a-f0-9]{32}$");
    private static bool ValidDigest(string? value) => value is not null && System.Text.RegularExpressions.Regex.IsMatch(value, "^[a-f0-9]{64}$");
    private static bool ValidRelativeFile(string? value) => value is not null && System.Text.RegularExpressions.Regex.IsMatch(value, "^(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$") && !value.Contains("..", StringComparison.Ordinal);
    private static bool ValidFileName(string? value) => value is not null && System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Za-z0-9._-]+$");
    private static bool ExactProperties(JsonElement value, params string[] names) => value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Select(x => x.Name).OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(names.OrderBy(x => x, StringComparer.Ordinal), StringComparer.Ordinal);
    private static string DigestFile(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    private static string DigestHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, WindowsNative.ByHandleFileInformation identity)
    {
        var length = ((long)identity.FileSizeHigh << 32) | identity.FileSizeLow;
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        for (long offset = 0; offset < length;)
        {
            var count = RandomAccess.Read(handle, buffer.AsSpan(0, (int)Math.Min(buffer.Length, length - offset)), offset);
            if (count == 0) throw new GuardianLaunchUnavailableException();
            hash.AppendData(buffer, 0, count);
            offset += count;
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }
}
