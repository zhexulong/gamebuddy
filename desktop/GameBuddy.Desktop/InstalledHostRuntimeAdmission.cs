using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography;
using System.Text.Json;

namespace GameBuddy.Desktop;

internal sealed class AdmittedHostRuntime : IDisposable, IAsyncDisposable
{
    private AdmittedRuntimeFile? runtime;
    private AdmittedRuntimeFile? bootstrap;

    internal AdmittedHostRuntime(AdmittedRuntimeFile runtime, AdmittedRuntimeFile bootstrap)
    {
        this.runtime = runtime;
        this.bootstrap = bootstrap;
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref bootstrap, null)?.Dispose();
        Interlocked.Exchange(ref runtime, null)?.Dispose();
    }

    public ValueTask DisposeAsync()
    {
        Dispose();
        return ValueTask.CompletedTask;
    }

    // These values originate only in the verified fixed admission contract and
    // are consumed by the Desktop-only native bootstrap supervisor.
    internal string RuntimePath => runtime?.RuntimePath ?? throw new GuardianLaunchUnavailableException();
    internal string BootstrapPath => bootstrap?.RuntimePath ?? throw new GuardianLaunchUnavailableException();

    internal void VerifyStillLocked()
    {
        (runtime ?? throw new GuardianLaunchUnavailableException()).VerifyStillLocked();
        (bootstrap ?? throw new GuardianLaunchUnavailableException()).VerifyStillLocked();
    }

    internal (AdmittedRuntimeFile Runtime, AdmittedRuntimeFile Bootstrap) TransferLocks()
    {
        var admittedRuntime = Interlocked.Exchange(ref runtime, null) ?? throw new GuardianLaunchUnavailableException();
        var admittedBootstrap = Interlocked.Exchange(ref bootstrap, null) ?? throw new GuardianLaunchUnavailableException();
        return (admittedRuntime, admittedBootstrap);
    }
}

internal sealed class InstalledHostRuntimeAdmission
{
    private const string AdmissionSchema = "host-runtime-admission/v1";
    private const string RuntimePath = "runtime/node.exe";
    private const string BootstrapPath = "desktop-runtime-bootstrap.internal.js";
    private const string RuntimeVersion = "v24.20.0";
    private const string RuntimePlatform = "win32";
    private const string RuntimeArch = "x64";

    internal AdmittedHostRuntime Admit(InstalledGenerationSelection selection)
    {
        ArgumentNullException.ThrowIfNull(selection);
        try
        {
            var bytes = selection.RuntimeAdmissionBytesCopy();
            if (bytes.Length == 0) throw new GuardianLaunchUnavailableException();
            using var document = JsonDocument.Parse(bytes);
            var value = document.RootElement;
            if (!InstalledGenerationPaths.ExactProperties(value, "schema", "inventoryDigest", "generation", "runtimePath", "runtimeSha256", "bootstrapPath", "bootstrapSha256", "runtimeVersion", "runtimePlatform", "runtimeArch", "runtimeClosure") ||
                value.GetProperty("schema").GetString() != AdmissionSchema || value.GetProperty("inventoryDigest").GetString() != selection.InventoryDigest || value.GetProperty("generation").GetString() != selection.Generation ||
                value.GetProperty("runtimePath").GetString() != RuntimePath || !InstalledGenerationPaths.ValidDigest(value.GetProperty("runtimeSha256").GetString()) || value.GetProperty("bootstrapPath").GetString() != BootstrapPath || !InstalledGenerationPaths.ValidDigest(value.GetProperty("bootstrapSha256").GetString()) ||
                value.GetProperty("runtimeVersion").GetString() != RuntimeVersion || value.GetProperty("runtimePlatform").GetString() != RuntimePlatform || value.GetProperty("runtimeArch").GetString() != RuntimeArch || !ValidRuntimeClosure(value.GetProperty("runtimeClosure")))
                throw new GuardianLaunchUnavailableException();

            var runtimeSha256 = value.GetProperty("runtimeSha256").GetString()!;
            var runtime = AdmitFile(selection.GenerationRoot, RuntimePath, runtimeSha256);
            try
            {
                var bootstrap = AdmitFile(selection.GenerationRoot, BootstrapPath, value.GetProperty("bootstrapSha256").GetString()!);
                return new AdmittedHostRuntime(runtime, bootstrap);
            }
            catch { runtime.Dispose(); throw; }
        }
        catch (GuardianLaunchUnavailableException) { throw; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or CryptographicException)
        {
            throw new GuardianLaunchUnavailableException(innerException: exception);
        }
    }

    private static bool ValidRuntimeClosure(JsonElement closure) =>
        InstalledGenerationPaths.ExactProperties(closure, "schema", "files") && closure.GetProperty("schema").GetString() == "host-bundled-runtime-closure/v1" && closure.GetProperty("files").ValueKind == JsonValueKind.Array;

    private static AdmittedRuntimeFile AdmitFile(string root, string relativePath, string expectedDigest)
    {
        var path = InstalledGenerationPaths.ChildFile(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        // FILE_EXECUTE is desired access; CreateFileW share mode permits only
        // documented read/write/delete sharing. Retain read-only sharing so the
        // admitted image cannot be replaced while its identity is verified.
        var handle = WindowsNative.CreateFile(WindowsNative.ToExtendedLengthPath(path), WindowsNative.FileReadData | WindowsNative.FileExecute, WindowsNative.FileShareRead, IntPtr.Zero, WindowsNative.OpenExisting, WindowsNative.FileAttributeNormal, IntPtr.Zero);
        if (handle.IsInvalid) WindowsNative.ThrowLastError("host_runtime_unavailable");
        try
        {
            if (!WindowsNative.GetFileInformationByHandle(handle, out var identity) || (identity.FileAttributes & (uint)FileAttributes.ReparsePoint) != 0) throw new GuardianLaunchUnavailableException();
            var admitted = new AdmittedRuntimeFile(handle, path, identity);
            admitted.VerifyStillLocked();
            if (!StringComparer.Ordinal.Equals(DigestHandle(handle, identity), expectedDigest)) throw new GuardianLaunchUnavailableException();
            admitted.VerifyStillLocked();
            return admitted;
        }
        catch { handle.Dispose(); throw; }
    }

    private static string DigestHandle(SafeFileHandle handle, WindowsNative.ByHandleFileInformation identity)
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

internal sealed class AdmittedRuntimeFile : IDisposable
{
    private readonly WindowsNative.ByHandleFileInformation identity;
    private readonly string path;

    internal AdmittedRuntimeFile(SafeFileHandle handle, string path, WindowsNative.ByHandleFileInformation identity)
    {
        Handle = handle;
        this.path = path;
        this.identity = identity;
    }

    internal SafeFileHandle Handle { get; }
    internal string RuntimePath => path;

    internal void VerifyStillLocked()
    {
        if (Handle.IsInvalid || !WindowsNative.GetFileInformationByHandle(Handle, out var current) || current.VolumeSerialNumber != identity.VolumeSerialNumber || current.FileIndexHigh != identity.FileIndexHigh || current.FileIndexLow != identity.FileIndexLow || (current.FileAttributes & (uint)FileAttributes.ReparsePoint) != 0)
            throw new GuardianLaunchUnavailableException();
        var buffer = new char[32768];
        var length = WindowsNative.GetFinalPathNameByHandle(Handle, buffer, (uint)buffer.Length, 0);
        var finalPath = length == 0 || length >= buffer.Length ? null : new string(buffer, 0, (int)length);
        if (finalPath is null || !StringComparer.OrdinalIgnoreCase.Equals(Normalize(finalPath), Normalize(path))) throw new GuardianLaunchUnavailableException();
    }

    public void Dispose() => Handle.Dispose();
    private static string Normalize(string value) => value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value[4..] : value;
}
