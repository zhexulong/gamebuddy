using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace GameBuddy.WindowsReparseInspector;

internal static class Program
{
    private const int LegacySchemaVersion = 1;
    private const int StrictIdentitySchemaVersion = 2;
    private const int StrictSecuritySchemaVersion = 3;
    private const string InspectOperation = "inspect";
    private const string InspectIdentityOperation = "inspect_identity_v2";
    private const string InspectPathChainOperation = "inspect_path_chain_v2";
    private const string InspectPathSecurityOperation = "inspect_path_security_v3";
    private const uint FileAttributeDevice = 0x00000040;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint FileReadAttributes = 0x00000080;
    private const uint ReadControl = 0x00020000;
    private const uint TokenQuery = 0x0008;
    private const uint OwnerSecurityInformation = 0x00000001;
    private const int SeFileObject = 1;
    private const int TokenInformationClassUser = 1;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const int MaximumRequestBytes = 64 * 1024;
    private const int MaximumPathCharacters = 32 * 1024;
    private const int MaximumChainComponents = 512;
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private const int ErrorInvalidName = 123;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    private static int Main()
    {
        Request? request = null;
        int? attemptedSchemaVersion = null;
        string? attemptedOperation = null;
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false, true);
            request = ReadRequest(out attemptedSchemaVersion, out attemptedOperation);
            switch (request.Operation)
            {
                case InspectOperation:
                    WriteLegacyResponse(InspectLegacy(request.Path));
                    break;
                case InspectIdentityOperation:
                    WriteIdentityResponse(InspectIdentity(request.Path));
                    break;
                case InspectPathChainOperation:
                    WriteChainResponse(InspectPathChain(request.Path));
                    break;
                case InspectPathSecurityOperation:
                    WriteSecurityResponse(InspectPathSecurity(request.Path));
                    break;
                default:
                    throw new InvalidDataException();
            }
            return 0;
        }
        catch
        {
            // Protocol and native failures never expose the input path or native details.
            var strictOperation = request is not null && (request.SchemaVersion == StrictIdentitySchemaVersion || request.SchemaVersion == StrictSecuritySchemaVersion)
                ? request.Operation
                : attemptedSchemaVersion is StrictIdentitySchemaVersion or StrictSecuritySchemaVersion
                    ? attemptedOperation
                    : null;
            if (strictOperation == InspectPathSecurityOperation) WriteSecurityResponse(SecurityInspection.Failure("indeterminate"));
            else if (strictOperation == InspectPathChainOperation) WriteChainResponse(ChainInspection.Failure("indeterminate"));
            else if (strictOperation == InspectIdentityOperation) WriteIdentityResponse(IdentityInspection.Failure("indeterminate"));
            else
            {
                WriteLegacyResponse("indeterminate");
            }
            return 0;
        }
    }

    private static Request ReadRequest(out int? attemptedSchemaVersion, out string? attemptedOperation)
    {
        attemptedSchemaVersion = null;
        attemptedOperation = null;
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
            MaxDepth = 4,
        });
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        var root = document.RootElement;
        if (root.TryGetProperty("schemaVersion", out var attemptedSchema) && attemptedSchema.ValueKind == JsonValueKind.Number && attemptedSchema.TryGetInt32(out var attemptedVersion)) attemptedSchemaVersion = attemptedVersion;
        if (root.TryGetProperty("operation", out var attemptedOperationProperty) && attemptedOperationProperty.ValueKind == JsonValueKind.String) attemptedOperation = attemptedOperationProperty.GetString();
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject())
        {
            if (!keys.Add(property.Name)) throw new InvalidDataException();
        }
        if (keys.Count != 3 || !keys.SetEquals(["schemaVersion", "operation", "path"])) throw new InvalidDataException();
        if (!root.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var version)) throw new InvalidDataException();
        attemptedSchemaVersion = version;
        if (!root.TryGetProperty("operation", out var operation) || operation.ValueKind != JsonValueKind.String) throw new InvalidDataException();
        if (!root.TryGetProperty("path", out var path) || path.ValueKind != JsonValueKind.String) throw new InvalidDataException();
        var operationValue = operation.GetString();
        attemptedOperation = operationValue;
        var pathValue = path.GetString();
        if (string.IsNullOrEmpty(operationValue) || string.IsNullOrEmpty(pathValue) || pathValue.Length > MaximumPathCharacters || pathValue.IndexOf('\0') >= 0 || HasFindFirstWildcard(pathValue) || !Path.IsPathFullyQualified(pathValue)) throw new InvalidDataException();
        if (version == LegacySchemaVersion && operationValue == InspectOperation) return new Request(version, operationValue, pathValue);
        if ((version == StrictIdentitySchemaVersion && (operationValue == InspectIdentityOperation || operationValue == InspectPathChainOperation)) ||
            (version == StrictSecuritySchemaVersion && operationValue == InspectPathSecurityOperation))
        {
            ValidateStrictDrivePath(pathValue);
            return new Request(version, operationValue, pathValue);
        }
        throw new InvalidDataException();
    }

    // FindFirstFileW recognizes both ordinary and DOS wildcard characters.
    // Exact-path inspection must reject all of them before invoking Win32.
    private static bool HasFindFirstWildcard(string path) => path.IndexOfAny(['*', '?', '<', '>', '"']) >= 0;

    private static bool HasUtf8Bom(byte[] bytes) => bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf;

    private static void ValidateStrictDrivePath(string path)
    {
        if (!OperatingSystem.IsWindows()) return;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) throw new InvalidDataException();
        if (path.IndexOf('/') >= 0) throw new InvalidDataException();
        var root = Path.GetPathRoot(path);
        if (root is null || root.Length != 3 || !IsAsciiDriveLetter(root[0]) || root[1] != ':' || root[2] != '\\') throw new InvalidDataException();
        if (path.Length < root.Length || !path.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
        var relative = path[root.Length..];
        if (relative.Length == 0) return;
        var components = relative.Split('\\');
        if (components.Length > MaximumChainComponents || components.Any(component => component.Length == 0 || component == "." || component == ".." || component.IndexOf(':') >= 0)) throw new InvalidDataException();
    }

    private static bool IsAsciiDriveLetter(char value) => value is >= 'A' and <= 'Z' or >= 'a' and <= 'z';

    private static string InspectLegacy(string path)
    {
        if (!OperatingSystem.IsWindows()) return "indeterminate";
        var extendedPath = ToExtendedLengthPath(path);
        var handle = NativeMethods.FindFirstFileW(extendedPath, out var data);
        if (handle == NativeMethods.InvalidHandleValue)
        {
            var error = Marshal.GetLastWin32Error();
            return error is ErrorFileNotFound or ErrorPathNotFound ? "missing" : "indeterminate";
        }
        try
        {
            return (data.FileAttributes & FileAttributeReparsePoint) != 0 ? "reparse" : "regular";
        }
        finally
        {
            NativeMethods.FindClose(handle);
        }
    }

    private static IdentityInspection InspectIdentity(string path)
    {
        if (!OperatingSystem.IsWindows()) return IdentityInspection.Failure("indeterminate");
        return InspectIdentityWindows(path);
    }

    private static IdentityInspection InspectIdentityWindows(string path)
    {
        var (handle, failure) = OpenIdentityHandle(path, retainNamespaceBinding: false);
        if (handle == NativeMethods.InvalidHandleValue) return IdentityInspection.Failure(failure);
        try
        {
            return QueryIdentity(handle);
        }
        finally
        {
            NativeMethods.CloseHandle(handle);
        }
    }

    private static (nint Handle, string Failure) OpenIdentityHandle(string path, bool retainNamespaceBinding)
    {
        var extendedPath = ToExtendedLengthPath(path);
        var shareMode = FileShareRead | FileShareWrite | (retainNamespaceBinding ? 0 : FileShareDelete);
        var handle = NativeMethods.CreateFileW(
            extendedPath,
            FileReadAttributes,
            shareMode,
            IntPtr.Zero,
            OpenExisting,
            FileFlagOpenReparsePoint | FileFlagBackupSemantics,
            IntPtr.Zero);
        if (handle != NativeMethods.InvalidHandleValue) return (handle, "indeterminate");
        var error = Marshal.GetLastWin32Error();
        return (NativeMethods.InvalidHandleValue, IsMissingError(error) ? "missing" : "indeterminate");
    }

    private static SecurityInspection InspectPathSecurity(string path)
    {
        if (!OperatingSystem.IsWindows()) return SecurityInspection.Failure("indeterminate");
        var handle = OpenSecurityHandle(path);
        if (handle == NativeMethods.InvalidHandleValue) return SecurityInspection.Failure("indeterminate");
        try
        {
            var identity = QueryIdentity(handle);
            if (identity.Status != "ok") return SecurityInspection.Failure("indeterminate");
            var currentUserOwner = IsCurrentUserOwner(handle);
            return currentUserOwner is null
                ? SecurityInspection.Failure("indeterminate")
                : SecurityInspection.Success(identity, currentUserOwner.Value);
        }
        finally
        {
            NativeMethods.CloseHandle(handle);
        }
    }

    private static nint OpenSecurityHandle(string path)
    {
        var handle = NativeMethods.CreateFileW(
            ToExtendedLengthPath(path),
            FileReadAttributes | ReadControl,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagOpenReparsePoint | FileFlagBackupSemantics,
            IntPtr.Zero);
        return handle;
    }

    private static bool? IsCurrentUserOwner(nint fileHandle)
    {
        nint securityDescriptor = IntPtr.Zero;
        nint token = IntPtr.Zero;
        nint tokenInformation = IntPtr.Zero;
        try
        {
            if (NativeMethods.GetSecurityInfo(fileHandle, SeFileObject, OwnerSecurityInformation, out var ownerSid, out _, out _, out _, out securityDescriptor) != 0 || ownerSid == IntPtr.Zero) return null;
            if (!NativeMethods.OpenProcessToken(NativeMethods.GetCurrentProcess(), TokenQuery, out token)) return null;
            NativeMethods.GetTokenInformation(token, TokenInformationClassUser, IntPtr.Zero, 0, out var requiredLength);
            if (requiredLength == 0) return null;
            tokenInformation = Marshal.AllocHGlobal(checked((int)requiredLength));
            if (!NativeMethods.GetTokenInformation(token, TokenInformationClassUser, tokenInformation, requiredLength, out var actualLength) || actualLength != requiredLength) return null;
            var tokenUser = Marshal.PtrToStructure<TokenUser>(tokenInformation);
            return tokenUser.UserSid != IntPtr.Zero && NativeMethods.EqualSid(ownerSid, tokenUser.UserSid);
        }
        catch
        {
            return null;
        }
        finally
        {
            if (tokenInformation != IntPtr.Zero) Marshal.FreeHGlobal(tokenInformation);
            if (token != IntPtr.Zero) NativeMethods.CloseHandle(token);
            if (securityDescriptor != IntPtr.Zero) NativeMethods.LocalFree(securityDescriptor);
        }
    }

    private static IdentityInspection QueryIdentity(nint handle)
    {
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileInformationClass.Basic, out FileBasicInfo basic, (uint)Marshal.SizeOf<FileBasicInfo>())) return IdentityInspection.Failure("indeterminate");
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileInformationClass.Standard, out FileStandardInfo standard, (uint)Marshal.SizeOf<FileStandardInfo>())) return IdentityInspection.Failure("indeterminate");
        if (!NativeMethods.GetFileInformationByHandleEx(handle, FileInformationClass.Id, out FileIdInfo id, (uint)Marshal.SizeOf<FileIdInfo>())) return IdentityInspection.Failure("indeterminate");
        var isDirectory = standard.Directory != 0;
        if ((basic.FileAttributes & FileAttributeDevice) != 0) return IdentityInspection.Failure("unsupported");
        var kind = isDirectory ? "directory" : "regular_file";
        var fileId = Convert.ToHexString(id.FileId).ToLowerInvariant();
        var volumeIdentity = id.VolumeSerialNumber.ToString("x16");
        return IdentityInspection.Success(kind, (basic.FileAttributes & FileAttributeReparsePoint) != 0, volumeIdentity, fileId);
    }

    private static ChainInspection InspectPathChain(string path)
    {
        if (!OperatingSystem.IsWindows()) return ChainInspection.Failure("indeterminate");
        ValidateStrictDrivePath(path);
        var root = Path.GetPathRoot(path)!;
        var componentPaths = new List<string> { root };
        var current = root.TrimEnd('\\');
        var relative = path[root.Length..];
        if (relative.Length > 0)
        {
            foreach (var component in relative.Split('\\'))
            {
                current += "\\" + component;
                componentPaths.Add(current);
            }
        }
        if (componentPaths.Count > MaximumChainComponents + 1) return ChainInspection.Failure("unsupported");
        var handles = new List<nint>(componentPaths.Count);
        var identities = new List<IdentityInspection>(componentPaths.Count);
        try
        {
            // Retain every no-follow handle until all identities are collected.
            // Without FILE_SHARE_DELETE, no inspected namespace component can
            // be renamed or deleted while this exact root-to-leaf proof exists.
            foreach (var componentPath in componentPaths)
            {
                var (handle, failure) = OpenIdentityHandle(componentPath, retainNamespaceBinding: true);
                if (handle == NativeMethods.InvalidHandleValue) return ChainInspection.Failure(failure);
                handles.Add(handle);
                var identity = QueryIdentity(handle);
                if (identity.Status != "ok") return ChainInspection.Failure(identity.Status);
                identities.Add(identity);
            }
            return ChainInspection.Success(identities);
        }
        finally
        {
            foreach (var handle in handles.AsEnumerable().Reverse()) NativeMethods.CloseHandle(handle);
        }
    }

    private static bool IsMissingError(int error) => error is ErrorFileNotFound or ErrorPathNotFound or ErrorInvalidName;

    internal static string ToExtendedLengthPath(string path)
    {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path[2..];
        return @"\\?\" + path;
    }

    private static void WriteLegacyResponse(string result)
    {
        Console.Out.Write("{\"schemaVersion\":1,\"result\":\"");
        Console.Out.Write(result);
        Console.Out.Write("\"}\n");
    }

    private static void WriteIdentityResponse(IdentityInspection inspection)
    {
        if (inspection.Status != "ok")
        {
            Console.Out.Write("{\"schemaVersion\":2,\"operation\":\"inspect_identity_v2\",\"status\":\"");
            Console.Out.Write(inspection.Status);
            Console.Out.Write("\"}\n");
            return;
        }
        Console.Out.Write("{\"schemaVersion\":2,\"operation\":\"inspect_identity_v2\",\"status\":\"ok\",\"objectKind\":\"");
        Console.Out.Write(inspection.ObjectKind);
        Console.Out.Write("\",\"isReparsePoint\":");
        Console.Out.Write(inspection.IsReparsePoint ? "true" : "false");
        Console.Out.Write(",\"volumeIdentity\":\"");
        Console.Out.Write(inspection.VolumeIdentity);
        Console.Out.Write("\",\"fileId\":\"");
        Console.Out.Write(inspection.FileId);
        Console.Out.Write("\"}\n");
    }

    private static void WriteSecurityResponse(SecurityInspection inspection)
    {
        if (inspection.Status != "ok")
        {
            Console.Out.Write("{\"schemaVersion\":3,\"operation\":\"inspect_path_security_v3\",\"status\":\"");
            Console.Out.Write(inspection.Status);
            Console.Out.Write("\"}\n");
            return;
        }
        Console.Out.Write("{\"schemaVersion\":3,\"operation\":\"inspect_path_security_v3\",\"status\":\"ok\",\"objectKind\":\"");
        Console.Out.Write(inspection.Identity!.ObjectKind);
        Console.Out.Write("\",\"isReparsePoint\":");
        Console.Out.Write(inspection.Identity.IsReparsePoint ? "true" : "false");
        Console.Out.Write(",\"currentUserOwner\":");
        Console.Out.Write(inspection.CurrentUserOwner ? "true" : "false");
        Console.Out.Write(",\"volumeIdentity\":\"");
        Console.Out.Write(inspection.Identity.VolumeIdentity);
        Console.Out.Write("\",\"fileId\":\"");
        Console.Out.Write(inspection.Identity.FileId);
        Console.Out.Write("\"}\n");
    }

    private static void WriteChainResponse(ChainInspection inspection)
    {
        if (inspection.Status != "ok")
        {
            Console.Out.Write("{\"schemaVersion\":2,\"operation\":\"inspect_path_chain_v2\",\"status\":\"");
            Console.Out.Write(inspection.Status);
            Console.Out.Write("\"}\n");
            return;
        }
        Console.Out.Write("{\"schemaVersion\":2,\"operation\":\"inspect_path_chain_v2\",\"status\":\"ok\",\"components\":[");
        for (var index = 0; index < inspection.Components!.Count; index++)
        {
            if (index > 0) Console.Out.Write(',');
            var component = inspection.Components[index];
            Console.Out.Write("{\"objectKind\":\"");
            Console.Out.Write(component.ObjectKind);
            Console.Out.Write("\",\"isReparsePoint\":");
            Console.Out.Write(component.IsReparsePoint ? "true" : "false");
            Console.Out.Write(",\"volumeIdentity\":\"");
            Console.Out.Write(component.VolumeIdentity);
            Console.Out.Write("\",\"fileId\":\"");
            Console.Out.Write(component.FileId);
            Console.Out.Write("\"}");
        }
        Console.Out.Write("]}\n");
    }

    private sealed record Request(int SchemaVersion, string Operation, string Path);

    private sealed record IdentityInspection(string Status, string? ObjectKind, bool IsReparsePoint, string? VolumeIdentity, string? FileId)
    {
        internal static IdentityInspection Failure(string status) => new(status, null, false, null, null);
        internal static IdentityInspection Success(string objectKind, bool isReparsePoint, string volumeIdentity, string fileId) => new("ok", objectKind, isReparsePoint, volumeIdentity, fileId);
    }

    private sealed record SecurityInspection(string Status, IdentityInspection? Identity, bool CurrentUserOwner)
    {
        internal static SecurityInspection Failure(string status) => new(status, null, false);
        internal static SecurityInspection Success(IdentityInspection identity, bool currentUserOwner) => new("ok", identity, currentUserOwner);
    }

    private sealed record ChainInspection(string Status, IReadOnlyList<IdentityInspection>? Components)
    {
        internal static ChainInspection Failure(string status) => new(status, null);
        internal static ChainInspection Success(IReadOnlyList<IdentityInspection> components) => new("ok", components);
    }

    private static class FileInformationClass
    {
        internal const int Basic = 0;
        internal const int Standard = 1;
        internal const int Id = 18;
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
    private struct TokenUser
    {
        public IntPtr UserSid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Win32FindData
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint Reserved0;
        public uint Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string FileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AlternateFileName;
    }

    private static class NativeMethods
    {
        internal static readonly nint InvalidHandleValue = new(-1);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern nint FindFirstFileW(string fileName, out Win32FindData findFileData);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool FindClose(nint findFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern nint CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(nint hObject);

        [DllImport("kernel32.dll")]
        internal static extern nint GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool OpenProcessToken(nint processHandle, uint desiredAccess, out nint tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetTokenInformation(nint tokenHandle, int tokenInformationClass, nint tokenInformation, uint tokenInformationLength, out uint returnLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern uint GetSecurityInfo(nint handle, int objectType, uint securityInformation, out nint ownerSid, out nint groupSid, out nint dacl, out nint sacl, out nint securityDescriptor);

        [DllImport("advapi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool EqualSid(nint sid1, nint sid2);

        [DllImport("kernel32.dll")]
        internal static extern nint LocalFree(nint memory);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(nint hFile, int fileInformationClass, out FileBasicInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(nint hFile, int fileInformationClass, out FileStandardInfo fileInformation, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(nint hFile, int fileInformationClass, out FileIdInfo fileInformation, uint bufferSize);
    }
}
