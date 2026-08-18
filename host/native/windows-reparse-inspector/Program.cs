using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace GameBuddy.WindowsReparseInspector;

internal static class Program
{
    private const int SchemaVersion = 1;
    private const string Operation = "inspect";
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const int MaximumRequestBytes = 64 * 1024;
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    private static int Main()
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false, true);
            var request = ReadRequest();
            WriteResponse(Inspect(request.Path));
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
            MaxDepth = 4,
        });
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
        var root = document.RootElement;
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject())
        {
            if (!keys.Add(property.Name)) throw new InvalidDataException();
        }
        if (keys.Count != 3 || !keys.SetEquals(["schemaVersion", "operation", "path"])) throw new InvalidDataException();
        if (!root.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var version) || version != SchemaVersion) throw new InvalidDataException();
        if (!root.TryGetProperty("operation", out var operation) || operation.ValueKind != JsonValueKind.String || operation.GetString() != Operation) throw new InvalidDataException();
        if (!root.TryGetProperty("path", out var path) || path.ValueKind != JsonValueKind.String) throw new InvalidDataException();
        var value = path.GetString();
        if (string.IsNullOrEmpty(value) || value.IndexOf('\0') >= 0 || HasFindFirstWildcard(value) || !Path.IsPathFullyQualified(value)) throw new InvalidDataException();
        return new Request(value);
    }

    // FindFirstFileW recognizes both ordinary and DOS wildcard characters.
    // Exact-path inspection must reject all of them before invoking Win32.
    private static bool HasFindFirstWildcard(string path) => path.IndexOfAny(['*', '?', '<', '>', '"']) >= 0;

    private static bool HasUtf8Bom(byte[] bytes) => bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf;

    private static string Inspect(string path)
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

    internal static string ToExtendedLengthPath(string path)
    {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path[2..];
        return @"\\?\" + path;
    }

    private static void WriteResponse(string result)
    {
        Console.Out.Write("{\"schemaVersion\":1,\"result\":\"");
        Console.Out.Write(result);
        Console.Out.Write("\"}\n");
    }

    private sealed record Request(string Path);

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
    }
}
