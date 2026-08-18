using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GameBuddy.WindowsStaleLockReclaimer;

/// <summary>
/// Single-purpose win-x64 helper for the Host's handle-bound lock policy. Its
/// v1 protocol has exactly two fixed operations: <c>reclaim_stale_lock</c> and
/// <c>release_owned_lock</c>. It is not a generic deletion, move, cleanup or
/// inspection service: it never accepts a caller-selected operation, directory,
/// glob, root, recursive flag, or arbitrary disposition. Both operations accept
/// only one frozen drive root plus literal safe relative segments; the final
/// segment must end in <c>.lock</c>. Release additionally requires the exact
/// owning UUID token and deletes only when the bytes read through its opened
/// HANDLE still prove that token.
///
/// Every file-object operation is performed through a retained HANDLE chain:
/// the drive root is opened once and must be a non-reparse directory; every
/// ancestor segment is opened with NtCreateFile relative to the retained parent
/// as RootDirectory with no-follow/reparse-safe semantics and verified as a
/// non-reparse directory before it replaces the retained parent; the final
/// leaf is opened relative to that retained parent. The leaf HANDLE is retained
/// for all owner classification, both observations, byte re-reads, native PID
/// liveness revalidation and the final disposition. A pathname is never
/// re-resolved after the chain starts. While the chain is retained, none of its
/// handles grants delete sharing, so Windows rejects a rename/delete that
/// would rebind any retained namespace component; only the current leaf name
/// can receive a disposition through its retained HANDLE.
///
/// For <c>stale_valid_dead</c> the helper itself revalidates through its
/// retained leaf HANDLE that the owner PID is not live: strict valid owner
/// grammar, stale <c>createdAtMs</c> and stale <c>LastWriteTime</c>, a first
/// native liveness check, then after the bounded observation interval the same
/// file facts and same owner bytes, and a second native liveness check for the
/// reread owner PID immediately before disposition. Any live PID, PID check
/// error, owner mutation or ambiguity returns a conservative kept category;
/// PID reuse may conservatively keep a stale lock, never justify deletion.
///
/// All failure modes (unavailable API, unsupported filesystem, access/share
/// failure, malformed request, timeout, missing file, reparse point,
/// non-regular leaf, identity mismatch, unrecognized native result) fail closed
/// and return only a frozen status category. No raw path, owner bytes, header,
/// Win32 diagnostic, ID, timestamp or process data is ever logged or exposed.
/// </summary>
internal static class Program
{
    private const int SchemaVersion = 1;
    private const string ReclaimOperation = "reclaim_stale_lock";
    private const string ReleaseOperation = "release_owned_lock";
    private const string StaleMalformedPolicy = "stale_malformed";
    private const string StaleValidDeadPolicy = "stale_valid_dead";
    private const int MaximumRequestBytes = 64 * 1024;
    private const int MaximumOwnerBytes = 65_536;
    private const int MaximumJsonDepth = 32;
    /// <summary>Frozen bounded interval during which the retained HANDLE is
    /// re-queried before any reclaim disposition is even considered.</summary>
    private const int ObservationIntervalMs = 100;
    private const long StaleIntervalMs = 5 * 60_000L;
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint FileAttributeDirectory = 0x00000010;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagSynchronousIoNonalert = 0x00000020;
    private const uint FileReadData = 0x0001;
    private const uint FileListDirectory = 0x0001;
    private const uint FileReadAttributes = 0x0080;
    private const uint DeleteAccess = 0x00010000;
    private const uint SynchronizeAccess = 0x00100000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x80;
    /// <summary>NtCreateFile disposition FILE_OPEN: never create, only open an
    /// existing object through the retained chain.</summary>
    private const uint FileOpenDisposition = 1;
    private const uint FileDirectoryFile = 0x00000001;
    private const uint FileNonDirectoryFile = 0x00000040;
    private const uint FileOpenForBackupIntent = 0x00004000;
    private const uint FileOpenReparsePointOption = 0x00200000;
    private const uint FileSynchronousIoNonalert = 0x00000020;
    private const uint ObjectCaseInsensitive = 0x00000040;
    private const uint StatusObjectNameNotFound = 0xC0000034;
    private const uint StatusObjectPathNotFound = 0xC000003A;
    private const uint StatusNotADirectory = 0xC0000103;
    private const uint StatusFileIsADirectory = 0xC00000BA;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly Regex TokenPattern = new("^[0-9a-f-]{36}$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        "CONIN$", "CONOUT$",
    };

    private static int Main()
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false, true);
            var request = ReadRequest();
            var result = request.Operation == ReclaimOperation ? Reclaim(request) : Release(request);
            WriteResponse(result);
            return 0;
        }
        catch
        {
            // Protocol failures deliberately use the same safe category as an
            // unavailable native result and never expose input/native details.
            WriteResponse("indeterminate");
            return 0;
        }
    }

    private static Request ReadRequest()
    {
        using var input = Console.OpenStandardInput();
        using var buffer = new MemoryStream();
        var chunk = new byte[4096];
        int read;
        while ((read = input.Read(chunk, 0, chunk.Length)) > 0)
        {
            if (buffer.Length + read > MaximumRequestBytes) throw new InvalidDataException();
            buffer.Write(chunk, 0, read);
        }
        var bytes = buffer.ToArray();
        if (bytes.Length == 0 || HasUtf8Bom(bytes)) throw new InvalidDataException();
        var json = StrictUtf8.GetString(bytes);
        if (json.Length == 0 || json.Contains('\r') || json.Contains('\n')) throw new InvalidDataException();

        using var document = JsonDocument.Parse(json, new JsonDocumentOptions
        {
            AllowTrailingCommas = false,
            CommentHandling = JsonCommentHandling.Disallow,
            MaxDepth = MaximumJsonDepth,
        });
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        var root = document.RootElement;
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject())
        {
            if (!keys.Add(property.Name)) throw new InvalidDataException();
        }
        if (!root.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var version) || version != SchemaVersion) throw new InvalidDataException();
        if (!root.TryGetProperty("operation", out var operation) || operation.ValueKind != JsonValueKind.String) throw new InvalidDataException();
        var operationValue = operation.GetString();
        if (operationValue != ReclaimOperation && operationValue != ReleaseOperation) throw new InvalidDataException();
        if (!root.TryGetProperty("root", out var rootProperty) || rootProperty.ValueKind != JsonValueKind.String) throw new InvalidDataException();
        var rootValue = rootProperty.GetString();
        if (rootValue == null || !IsValidDriveRoot(rootValue)) throw new InvalidDataException();
        if (!root.TryGetProperty("segments", out var segmentsProperty) || segmentsProperty.ValueKind != JsonValueKind.Array) throw new InvalidDataException();
        var segments = new List<string>();
        foreach (var element in segmentsProperty.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String) throw new InvalidDataException();
            var segment = element.GetString();
            if (segment == null) throw new InvalidDataException();
            segments.Add(segment);
        }
        var segmentsValue = segments.ToArray();
        if (!IsValidSegments(segmentsValue)) throw new InvalidDataException();
        if (operationValue == ReclaimOperation)
        {
            if (keys.Count != 5 || !keys.SetEquals(["schemaVersion", "operation", "policy", "root", "segments"])) throw new InvalidDataException();
            if (!root.TryGetProperty("policy", out var policy) || policy.ValueKind != JsonValueKind.String) throw new InvalidDataException();
            var policyValue = policy.GetString();
            if (policyValue != StaleMalformedPolicy && policyValue != StaleValidDeadPolicy) throw new InvalidDataException();
            return new Request(ReclaimOperation, rootValue, segmentsValue, policyValue, null);
        }
        if (keys.Count != 5 || !keys.SetEquals(["schemaVersion", "operation", "token", "root", "segments"])) throw new InvalidDataException();
        if (!root.TryGetProperty("token", out var token) || token.ValueKind != JsonValueKind.String) throw new InvalidDataException();
        var tokenValue = token.GetString();
        if (tokenValue == null || !TokenPattern.IsMatch(tokenValue)) throw new InvalidDataException();
        return new Request(ReleaseOperation, rootValue, segmentsValue, null, tokenValue);
    }

    private static bool HasUtf8Bom(byte[] bytes) => bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf;

    /// <summary>Root is exactly one drive letter, a colon and one backslash;
    /// uppercase or lowercase drive letters are both accepted. UNC, volume
    /// GUID, device, relative and every other root form fail closed.</summary>
    private static bool IsValidDriveRoot(string root)
    {
        return root.Length == 3 && char.IsAsciiLetter(root[0]) && root[1] == ':' && root[2] == '\\';
    }

    /// <summary>Segments are non-empty, each is exactly one literal safe
    /// component, and the final component ends in <c>.lock</c>.</summary>
    private static bool IsValidSegments(string[] segments)
    {
        if (segments.Length == 0) return false;
        for (var index = 0; index < segments.Length; index++)
        {
            var segment = segments[index];
            if (!IsSafeSegment(segment)) return false;
            if (index == segments.Length - 1 && !segment.EndsWith(".lock", StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    private static bool IsSafeSegment(string segment)
    {
        if (segment.Length == 0 || segment == "." || segment == "..") return false;
        if (segment.IndexOf('\0') >= 0 || segment.IndexOfAny(['\\', '/', ':', '*', '?', '<', '>', '"', '|']) >= 0) return false;
        // Windows strips trailing dots/spaces, which would alias a different
        // object; a literal safe component must not rely on that behavior.
        if (segment.EndsWith(' ') || segment.EndsWith('.')) return false;
        return !IsReservedDeviceName(segment);
    }

    private static bool IsReservedDeviceName(string segment)
    {
        var baseName = segment.Split('.')[0];
        return baseName.Length > 0 && ReservedNames.Contains(baseName);
    }

    private static string Reclaim(Request request)
    {
        if (!OperatingSystem.IsWindows()) return "indeterminate";
        var (chain, openCategory) = OpenChain(request.Root, request.Segments);
        try
        {
            if (chain == null) return openCategory;
            var handle = chain.Leaf;
            var before = Query(handle);
            if (before == null) return "indeterminate";
            if (!before.IsRegularFile) return "kept_not_regular";
            var owner = ReadOwner(handle, before.Size);
            if (owner == null) return "indeterminate";
            var now = DateTime.UtcNow;
            if (request.Policy == StaleMalformedPolicy)
            {
                if (owner.Kind != OwnerKind.Malformed && owner.Kind != OwnerKind.ZeroByte) return "kept_policy_mismatch";
                if (!IsStale(before.LastWriteTimeUtc, now)) return "kept_malformed_fresh";
            }
            else
            {
                if (owner.Kind != OwnerKind.Valid) return "kept_policy_mismatch";
                if (!IsOldEnough(owner.CreatedAtMs!.Value)) return "kept_valid_fresh";
                if (!IsStale(before.LastWriteTimeUtc, now)) return "kept_valid_fresh";
                // First native liveness revalidation: the Host's dead-proof only
                // selects the selector; the helper must itself prove the owner
                // PID read through its retained HANDLE is not live.
                if (NativeProcessAlive(owner.Pid!.Value)) return "kept_policy_mismatch";
            }

            // Wait the bounded frozen observation interval while retaining the
            // same HANDLE, then re-query the same handle's file ID, size, mtime
            // and ctime and re-read its owner bytes. Any mutation, reparse or
            // non-regular transition, read failure, handle failure, owner
            // reclassification or unexpected status keeps/fails closed.
            Thread.Sleep(ObservationIntervalMs);
            var after = Query(handle);
            if (after == null) return "indeterminate";
            if (!after.IsRegularFile) return "kept_not_regular";
            if (!SameFileFacts(before, after)) return "kept_identity_changed";
            var ownerAfter = ReadOwner(handle, after.Size);
            if (ownerAfter == null) return "indeterminate";
            if (!owner.SameOwner(ownerAfter)) return "kept_identity_changed";

            // Second native liveness revalidation for the reread owner PID,
            // immediately before the disposition. The pathname is never
            // re-resolved: the disposition applies to this exact opened object.
            if (request.Policy == StaleValidDeadPolicy && NativeProcessAlive(ownerAfter.Pid!.Value)) return "kept_policy_mismatch";
            if (!DeleteViaHandle(handle)) return "indeterminate";
            return "reclaimed";
        }
        finally
        {
            chain?.Dispose();
        }
    }

    private static string Release(Request request)
    {
        if (!OperatingSystem.IsWindows()) return "indeterminate";
        var (chain, openCategory) = OpenChain(request.Root, request.Segments);
        try
        {
            if (chain == null) return openCategory;
            var handle = chain.Leaf;
            var facts = Query(handle);
            if (facts == null) return "indeterminate";
            if (!facts.IsRegularFile) return "kept_not_regular";
            var owner = ReadOwner(handle, facts.Size);
            if (owner == null) return "indeterminate";
            if (owner.Kind != OwnerKind.Valid || !string.Equals(owner.Token, request.Token, StringComparison.Ordinal))
                return "kept_token_mismatch";
            if (!DeleteViaHandle(handle)) return "indeterminate";
            return "released";
        }
        finally
        {
            chain?.Dispose();
        }
    }

    /// <summary>Opens the frozen drive root once and verifies it is a
    /// non-reparse directory, then opens every ancestor segment relative to
    /// its still-retained parent and verifies each is a non-reparse directory.
    /// Every root/ancestor HANDLE stays open until the leaf disposition is
    /// finished, so none of the namespace components can be renamed or deleted
    /// during the observation window. No pathname is re-resolved after the
    /// chain starts.</summary>
    private static (OpenedChain? Chain, string Category) OpenChain(string root, string[] segments)
    {
        var handles = new List<nint>();
        var (parent, category) = OpenDriveRoot(root);
        if (parent == NativeMethods.InvalidHandleValue) return (null, category);
        handles.Add(parent);
        for (var index = 0; index < segments.Length - 1; index++)
        {
            var (child, childCategory) = OpenChildDirectory(parent, segments[index]);
            if (child == NativeMethods.InvalidHandleValue)
            {
                CloseAll(handles);
                return (null, childCategory);
            }
            handles.Add(child);
            parent = child;
        }
        var (leaf, leafCategory) = OpenLeaf(parent, segments[segments.Length - 1]);
        if (leaf == NativeMethods.InvalidHandleValue)
        {
            CloseAll(handles);
            return (null, leafCategory);
        }
        handles.Add(leaf);
        return (new OpenedChain(handles), "indeterminate");
    }

    private static void CloseAll(IEnumerable<nint> handles)
    {
        foreach (var handle in handles.Reverse()) NativeMethods.CloseHandle(handle);
    }

    private sealed class OpenedChain : IDisposable
    {
        private readonly List<nint> handles;

        internal OpenedChain(List<nint> handles)
        {
            this.handles = handles;
        }

        internal nint Leaf => handles[^1];

        public void Dispose()
        {
            CloseAll(handles);
            handles.Clear();
        }
    }

    private static (nint Handle, string Category) OpenDriveRoot(string root)
    {
        var handle = NativeMethods.CreateFileW(
            root,
            FileListDirectory | FileReadAttributes | SynchronizeAccess,
            // Do not grant delete sharing while this root-to-leaf chain is
            // retained. A rename or delete needs FILE_SHARE_DELETE from every
            // open HANDLE, so this closes the namespace-rebind window without
            // re-resolving any pathname before disposition.
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            OpenExisting,
            FileFlagOpenReparsePoint | FileFlagBackupSemantics | FileFlagSynchronousIoNonalert,
            IntPtr.Zero);
        if (handle == NativeMethods.InvalidHandleValue)
        {
            var error = Marshal.GetLastWin32Error();
            return (NativeMethods.InvalidHandleValue, error is ErrorFileNotFound or ErrorPathNotFound ? "missing" : "indeterminate");
        }
        if (!IsNonReparseDirectory(handle))
        {
            NativeMethods.CloseHandle(handle);
            return (NativeMethods.InvalidHandleValue, "kept_not_regular");
        }
        return (handle, "indeterminate");
    }

    private static (nint Handle, string Category) OpenChildDirectory(nint rootDirectory, string name)
    {
        var (handle, status) = NtOpenChild(rootDirectory, name, FileListDirectory | FileReadAttributes | SynchronizeAccess, FileShareRead | FileShareWrite, FileDirectoryFile | FileOpenReparsePointOption | FileSynchronousIoNonalert);
        // NtCreateFile returns a NULL handle on failure, never -1; both
        // sentinels mean the open failed and the status must be mapped.
        if (handle == NativeMethods.InvalidHandleValue || handle == IntPtr.Zero) return (NativeMethods.InvalidHandleValue, MapOpenStatus(status));
        if (!IsNonReparseDirectory(handle))
        {
            NativeMethods.CloseHandle(handle);
            return (NativeMethods.InvalidHandleValue, "kept_not_regular");
        }
        return (handle, "indeterminate");
    }

    private static (nint Handle, string Category) OpenLeaf(nint rootDirectory, string name)
    {
        // FILE_NON_DIRECTORY_FILE rejects a directory leaf at open time;
        // FILE_OPEN_REPARSE_POINT opens a reparse leaf itself, never a target.
        var (handle, status) = NtOpenChild(rootDirectory, name, FileReadData | FileReadAttributes | DeleteAccess | SynchronizeAccess, FileShareRead | FileShareWrite, FileNonDirectoryFile | FileOpenReparsePointOption | FileOpenForBackupIntent | FileSynchronousIoNonalert);
        if (handle == NativeMethods.InvalidHandleValue || handle == IntPtr.Zero) return (NativeMethods.InvalidHandleValue, MapOpenStatus(status));
        return (handle, "indeterminate");
    }

    private static (nint Handle, uint Status) NtOpenChild(nint rootDirectory, string name, uint desiredAccess, uint shareAccess, uint createOptions)
    {
        var nameBytes = Encoding.Unicode.GetBytes(name);
        var namePin = GCHandle.Alloc(nameBytes, GCHandleType.Pinned);
        var unicodeMemory = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeString>());
        try
        {
            var unicode = new UnicodeString
            {
                Length = checked((ushort)nameBytes.Length),
                MaximumLength = checked((ushort)nameBytes.Length),
                Buffer = namePin.AddrOfPinnedObject(),
            };
            Marshal.StructureToPtr(unicode, unicodeMemory, false);
            var attributes = new ObjectAttributes
            {
                Length = (uint)Marshal.SizeOf<ObjectAttributes>(),
                RootDirectory = rootDirectory,
                ObjectName = unicodeMemory,
                Attributes = ObjectCaseInsensitive,
                SecurityDescriptor = IntPtr.Zero,
                SecurityQualityOfService = IntPtr.Zero,
            };
            var status = NativeMethods.NtCreateFile(out var handle, desiredAccess, ref attributes, out _, IntPtr.Zero, 0, shareAccess, FileOpenDisposition, createOptions, IntPtr.Zero, 0);
            return (handle, status);
        }
        finally
        {
            Marshal.FreeHGlobal(unicodeMemory);
            namePin.Free();
        }
    }

    private static string MapOpenStatus(uint status)
    {
        if (status == StatusObjectNameNotFound || status == StatusObjectPathNotFound) return "missing";
        if (status == StatusNotADirectory || status == StatusFileIsADirectory) return "kept_not_regular";
        return "indeterminate";
    }

    private static bool IsNonReparseDirectory(nint handle)
    {
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileInformationClass.Basic, out FileBasicInfo basic, (uint)Marshal.SizeOf<FileBasicInfo>())) return false;
        return (basic.FileAttributes & (FileAttributeReparsePoint | FileAttributeDirectory)) == FileAttributeDirectory;
    }

    private static FileFacts? Query(nint handle)
    {
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileInformationClass.Basic, out FileBasicInfo basic, (uint)Marshal.SizeOf<FileBasicInfo>())) return null;
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileInformationClass.Standard, out FileStandardInfo standard, (uint)Marshal.SizeOf<FileStandardInfo>())) return null;
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileInformationClass.Id, out FileIdInfo id, (uint)Marshal.SizeOf<FileIdInfo>())) return null;
        return new FileFacts(id.VolumeSerialNumber, id.FileId, basic.FileAttributes, basic.LastWriteTime, basic.ChangeTime, standard.EndOfFile, standard.Directory);
    }

    private static OwnerInfo? ReadOwner(nint handle, long size)
    {
        if (size > MaximumOwnerBytes) return OwnerInfo.Malformed([]);
        if (size == 0) return OwnerInfo.ZeroByte([]);
        // Re-reads through the same retained HANDLE must start at the file
        // beginning again: ReadFile advances the file pointer.
        if (!NativeMethods.SetFilePointerEx(handle, 0, IntPtr.Zero, 0)) return null;
        var bytes = new byte[(int)size];
        var chunk = new byte[MaximumOwnerBytes];
        long offset = 0;
        while (offset < size)
        {
            var requested = (uint)Math.Min(size - offset, chunk.Length);
            if (!NativeMethods.ReadFile(handle, chunk, requested, out var read, IntPtr.Zero) || read == 0) return null;
            Buffer.BlockCopy(chunk, 0, bytes, (int)offset, (int)read);
            offset += read;
        }
        return ClassifyOwner(bytes);
    }

    private static OwnerInfo ClassifyOwner(byte[] bytes)
    {
        if (HasUtf8Bom(bytes)) return OwnerInfo.Malformed(bytes);
        string json;
        try
        {
            json = StrictUtf8.GetString(bytes);
        }
        catch
        {
            return OwnerInfo.Malformed(bytes);
        }
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = MaximumJsonDepth,
            });
            if (document.RootElement.ValueKind != JsonValueKind.Object) return OwnerInfo.Malformed(bytes);
            var root = document.RootElement;
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in root.EnumerateObject())
            {
                if (!keys.Add(property.Name)) return OwnerInfo.Malformed(bytes);
            }
            if (keys.Count != 3 || !keys.SetEquals(["token", "pid", "createdAtMs"])) return OwnerInfo.Malformed(bytes);
            if (!root.TryGetProperty("token", out var token) || token.ValueKind != JsonValueKind.String) return OwnerInfo.Malformed(bytes);
            var tokenValue = token.GetString();
            if (tokenValue == null || !TokenPattern.IsMatch(tokenValue)) return OwnerInfo.Malformed(bytes);
            if (!root.TryGetProperty("pid", out var pid) || pid.ValueKind != JsonValueKind.Number || !pid.TryGetInt64(out var pidValue)) return OwnerInfo.Malformed(bytes);
            if (!root.TryGetProperty("createdAtMs", out var createdAt) || createdAt.ValueKind != JsonValueKind.Number || !createdAt.TryGetInt64(out var createdAtValue)) return OwnerInfo.Malformed(bytes);
            return OwnerInfo.Valid(bytes, tokenValue, pidValue, createdAtValue);
        }
        catch
        {
            return OwnerInfo.Malformed(bytes);
        }
    }

    private static bool SameFileFacts(FileFacts left, FileFacts right)
    {
        return left.VolumeSerialNumber == right.VolumeSerialNumber
            && left.FileId.SequenceEqual(right.FileId)
            && left.Size == right.Size
            && left.LastWriteTimeUtc == right.LastWriteTimeUtc
            && left.ChangeTimeUtc == right.ChangeTimeUtc;
    }

    /// <summary>Conservative native liveness: only a definitive "no process
    /// with this ID" answer is dead. A non-positive PID is never a valid OS
    /// process and counts as ambiguous, so it is treated as alive and a stale
    /// lock is kept, never deleted. Every PID lookup error is likewise
    /// ambiguous and therefore treated as alive.</summary>
    private static bool NativeProcessAlive(long pid)
    {
        if (pid < 1 || pid > int.MaxValue) return true;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (Exception)
        {
            return true;
        }
    }

    private static bool DeleteViaHandle(nint handle)
    {
        var disposition = new FileDispositionInfo { DeleteFile = 1 }; // BOOLEAN true
        return NativeMethods.SetFileInformationByHandle(handle, FileInformationClass.Disposition, ref disposition, (uint)Marshal.SizeOf<FileDispositionInfo>());
    }

    private static bool IsStale(DateTime lastWriteUtc, DateTime nowUtc)
    {
        return nowUtc - lastWriteUtc >= TimeSpan.FromMilliseconds(StaleIntervalMs);
    }

    private static bool IsOldEnough(long createdAtMs)
    {
        try
        {
            var createdUtc = DateTimeOffset.FromUnixTimeMilliseconds(createdAtMs).UtcDateTime;
            return DateTime.UtcNow - createdUtc >= TimeSpan.FromMilliseconds(StaleIntervalMs);
        }
        catch (ArgumentOutOfRangeException)
        {
            return false;
        }
    }

    private static void WriteResponse(string result)
    {
        Console.Out.Write("{\"schemaVersion\":1,\"result\":\"");
        Console.Out.Write(result);
        Console.Out.Write("\"}\n");
    }

    private sealed record Request(string Operation, string Root, string[] Segments, string? Policy, string? Token);

    private static class FileInformationClass
    {
        internal const int Basic = 0;
        internal const int Standard = 1;
        internal const int Disposition = 4;
        internal const int Id = 18;
    }

    private enum OwnerKind
    {
        Valid,
        Malformed,
        ZeroByte,
    }

    private sealed class OwnerInfo
    {
        private OwnerInfo(OwnerKind kind, byte[] bytes, string? token, long? pid, long? createdAtMs)
        {
            Kind = kind;
            Bytes = bytes;
            Token = token;
            Pid = pid;
            CreatedAtMs = createdAtMs;
        }

        internal OwnerKind Kind { get; }
        internal byte[] Bytes { get; }
        internal string? Token { get; }
        internal long? Pid { get; }
        internal long? CreatedAtMs { get; }

        internal static OwnerInfo Valid(byte[] bytes, string token, long pid, long createdAtMs) => new(OwnerKind.Valid, bytes, token, pid, createdAtMs);
        internal static OwnerInfo Malformed(byte[] bytes) => new(OwnerKind.Malformed, bytes, null, null, null);
        internal static OwnerInfo ZeroByte(byte[] bytes) => new(OwnerKind.ZeroByte, bytes, null, null, null);

        internal bool SameOwner(OwnerInfo other) => Kind == other.Kind && Bytes.SequenceEqual(other.Bytes);
    }

    private sealed class FileFacts
    {
        internal FileFacts(ulong volumeSerialNumber, byte[] fileId, uint attributes, long lastWriteTime, long changeTime, long size, byte directory)
        {
            VolumeSerialNumber = volumeSerialNumber;
            FileId = fileId;
            Attributes = attributes;
            LastWriteTimeUtc = DateTime.FromFileTimeUtc(lastWriteTime);
            ChangeTimeUtc = DateTime.FromFileTimeUtc(changeTime);
            Size = size;
            IsDirectory = directory != 0;
        }

        internal ulong VolumeSerialNumber { get; }
        internal byte[] FileId { get; }
        internal uint Attributes { get; }
        internal DateTime LastWriteTimeUtc { get; }
        internal DateTime ChangeTimeUtc { get; }
        internal long Size { get; }
        internal bool IsDirectory { get; }

        internal bool IsRegularFile => (Attributes & FileAttributeReparsePoint) == 0 && !IsDirectory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileBasicInfo
    {
        public long CreationTime;
        public long LastAccessTime;
        public long LastWriteTime;
        public long ChangeTime;
        public uint FileAttributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileStandardInfo
    {
        public long AllocationSize;
        public long EndOfFile;
        public uint NumberOfLinks;
        public byte DeletePending;
        public byte Directory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo
    {
        public ulong VolumeSerialNumber;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] FileId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfo
    {
        public byte DeleteFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public nint Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public uint Length;
        public nint RootDirectory;
        public nint ObjectName;
        public uint Attributes;
        public nint SecurityDescriptor;
        public nint SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public nint Status;
        public nint Information;
    }

    private static class NativeMethods
    {
        internal static readonly nint InvalidHandleValue = new(-1);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern nint CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(nint hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ReadFile(nint hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetFilePointerEx(nint hFile, long liDistanceToMove, IntPtr lpNewFilePointer, uint dwMoveMethod);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(nint hFile, int fileInformationClass, out FileBasicInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(nint hFile, int fileInformationClass, out FileStandardInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(nint hFile, int fileInformationClass, out FileIdInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetFileInformationByHandle(nint hFile, int fileInformationClass, ref FileDispositionInfo fileInformation, uint bufferSize);

        [DllImport("ntdll.dll")]
        internal static extern uint NtCreateFile(
            out nint fileHandle,
            uint desiredAccess,
            ref ObjectAttributes objectAttributes,
            out IoStatusBlock ioStatusBlock,
            nint allocationSize,
            uint fileAttributes,
            uint shareAccess,
            uint createDisposition,
            uint createOptions,
            nint eaBuffer,
            uint eaLength);
    }
}
