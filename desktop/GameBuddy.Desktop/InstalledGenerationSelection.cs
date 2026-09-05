using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>One locked, immutable view of the Host generation selected by current.json.</summary>
internal sealed class InstalledGenerationSelection : IDisposable, IAsyncDisposable
{
    private const string PointerSchema = "gamebuddy-host-production-current/v2";
    private readonly FileStream pointerLock;
    private readonly byte[] runtimeAdmissionBytes;
    private bool disposed;

    private InstalledGenerationSelection(FileStream pointerLock, string programRoot, string generation, string inventoryDigest, string runtimeAdmissionSha256, string generationRoot, byte[] runtimeAdmissionBytes)
    {
        this.pointerLock = pointerLock;
        ProgramRoot = programRoot;
        Generation = generation;
        InventoryDigest = inventoryDigest;
        RuntimeAdmissionSha256 = runtimeAdmissionSha256;
        GenerationRoot = generationRoot;
        this.runtimeAdmissionBytes = runtimeAdmissionBytes;
    }

    internal string ProgramRoot { get; }
    internal string Generation { get; }
    internal string InventoryDigest { get; }
    internal string RuntimeAdmissionSha256 { get; }
    internal string GenerationRoot { get; }

    // The pointer-bound sidecar is an immutable selection snapshot. Callers receive
    // a fresh copy so no consumer can mutate the selected admission input.
    internal byte[] RuntimeAdmissionBytesCopy() => (byte[])runtimeAdmissionBytes.Clone();

    internal static InstalledGenerationSelection Acquire(string programRoot)
    {
        try
        {
            programRoot = InstalledGenerationPaths.CanonicalDirectory(programRoot);
            var pointerPath = InstalledGenerationPaths.ChildFile(programRoot, "current.json");
            var pointerLock = new FileStream(pointerPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            try
            {
                using var pointer = JsonDocument.Parse(ReadAll(pointerLock));
                var root = pointer.RootElement;
                if (!InstalledGenerationPaths.ExactProperties(root, "schema", "generation", "inventoryDigest", "runtimeAdmissionSha256") ||
                    root.GetProperty("schema").GetString() != PointerSchema ||
                    !InstalledGenerationPaths.ValidGeneration(root.GetProperty("generation").GetString()) ||
                    !InstalledGenerationPaths.ValidDigest(root.GetProperty("inventoryDigest").GetString()) ||
                    !InstalledGenerationPaths.ValidDigest(root.GetProperty("runtimeAdmissionSha256").GetString()))
                    throw new GuardianLaunchUnavailableException();

                var generation = root.GetProperty("generation").GetString()!;
                var runtimeAdmissionSha256 = root.GetProperty("runtimeAdmissionSha256").GetString()!;
                var generationRoot = InstalledGenerationPaths.ChildDirectory(InstalledGenerationPaths.ChildDirectory(programRoot, "generations"), generation);
                var runtimeAdmissionBytes = File.ReadAllBytes(InstalledGenerationPaths.ChildFile(generationRoot, "host-runtime-admission.json"));
                if (!StringComparer.Ordinal.Equals(Digest(runtimeAdmissionBytes), runtimeAdmissionSha256)) throw new GuardianLaunchUnavailableException();
                return new InstalledGenerationSelection(pointerLock, programRoot, generation, root.GetProperty("inventoryDigest").GetString()!, runtimeAdmissionSha256, generationRoot, runtimeAdmissionBytes);
            }
            catch { pointerLock.Dispose(); throw; }
        }
        catch (GuardianLaunchUnavailableException) { throw; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or CryptographicException)
        {
            throw new GuardianLaunchUnavailableException(innerException: exception);
        }
    }

    internal static InstalledGenerationSelection FromCurrentUserRegistration() => Acquire(CurrentUserRootLayout.DeriveForCurrentUser().ProgramRoot);

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        pointerLock.Dispose();
    }

    public ValueTask DisposeAsync()
    {
        Dispose();
        return ValueTask.CompletedTask;
    }

    private static string Digest(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static byte[] ReadAll(FileStream stream)
    {
        stream.Position = 0;
        using var bytes = new MemoryStream();
        stream.CopyTo(bytes);
        return bytes.ToArray();
    }
}

internal static class InstalledGenerationPaths
{
    internal static string ChildDirectory(string root, string relative)
    {
        var target = Path.GetFullPath(Path.Combine(root, relative));
        if (!IsInside(root, target)) throw new GuardianLaunchUnavailableException();
        EnsureOrdinaryAncestors(root, target);
        EnsureOrdinaryDirectory(target);
        return target;
    }

    internal static string ChildFile(string root, string relative)
    {
        var target = Path.GetFullPath(Path.Combine(root, relative));
        if (!IsInside(root, target)) throw new GuardianLaunchUnavailableException();
        EnsureOrdinaryAncestors(root, target);
        if (!File.Exists(target) || (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0) throw new GuardianLaunchUnavailableException();
        return target;
    }

    internal static bool ValidGeneration(string? value) => value is not null && System.Text.RegularExpressions.Regex.IsMatch(value, "^g-[0-9a-z]+-[0-9]+-[a-f0-9]{32}$");
    internal static bool ValidDigest(string? value) => value is not null && System.Text.RegularExpressions.Regex.IsMatch(value, "^[a-f0-9]{64}$");
    internal static bool ValidRelativeFile(string? value) => value is not null && System.Text.RegularExpressions.Regex.IsMatch(value, "^(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+$") && !value.Contains("..", StringComparison.Ordinal);
    internal static bool ExactProperties(JsonElement value, params string[] names) => value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Select(x => x.Name).OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(names.OrderBy(x => x, StringComparer.Ordinal), StringComparer.Ordinal);
    internal static string CanonicalDirectory(string path) { var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path)); EnsureOrdinaryDirectory(canonical); return canonical; }

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
}
