using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace GameBuddy.WindowsStardewFolderPicker;

/// <summary>Single-purpose Windows folder picker. The returned drive-rooted path is an untrusted candidate only.</summary>
internal static class Program
{
    private const uint FosPickFolders = 0x20;
    private const uint FosForceFileSystem = 0x40;
    private const uint FosNoChangeDir = 0x8;
    private const uint FosPathMustExist = 0x800;
    private const uint FosNoDereferenceLinks = 0x100000;
    private const uint SigDnFileSysPath = 0x80058000;
    private const int CancelledHresult = unchecked((int)0x800704C7);

    [STAThread]
    private static int Main()
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false, true);
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
            var dialog = (IFileOpenDialog)new FileOpenDialog();
            try
            {
                dialog.GetOptions(out var options);
                dialog.SetOptions(options | FosPickFolders | FosForceFileSystem | FosNoChangeDir | FosPathMustExist | FosNoDereferenceLinks);
                var result = dialog.Show(IntPtr.Zero);
                if (result == CancelledHresult) { WriteCancelled(); return 0; }
                Marshal.ThrowExceptionForHR(result);
                dialog.GetResult(out var item);
                try
                {
                    item.GetDisplayName(SigDnFileSysPath, out var pointer);
                    try
                    {
                        var path = Marshal.PtrToStringUni(pointer) ?? throw new InvalidOperationException();
                        if (!IsDriveRooted(path)) throw new InvalidOperationException();
                        Console.Out.Write("{\"schemaVersion\":1,\"status\":\"selected\",\"path\":");
                        Console.Out.Write(JsonSerializer.Serialize(path));
                        Console.Out.Write("}\n");
                    }
                    finally { Marshal.FreeCoTaskMem(pointer); }
                }
                finally { Marshal.ReleaseComObject(item); }
                return 0;
            }
            finally { Marshal.ReleaseComObject(dialog); }
        }
        catch
        {
            // No diagnostics, selected path, or native details may escape on stderr.
            return 1;
        }
    }

    private static void WriteCancelled() => Console.Out.Write("{\"schemaVersion\":1,\"status\":\"cancelled\"}\n");
    private static bool IsDriveRooted(string path) => path.Length >= 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '\\' && !path.Contains('/') && !path.Contains('\0');

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr filterSpec); void SetFileTypeIndex(uint index); void GetFileTypeIndex(out uint index); void Advise(IntPtr events, out uint cookie); void Unadvise(uint cookie);
        void SetOptions(uint options); void GetOptions(out uint options); void SetDefaultFolder(IShellItem item); void SetFolder(IShellItem item); void GetFolder(out IShellItem item); void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name); void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text); void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item); void AddPlace(IShellItem item, int placement); void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension); void Close(int error); void SetClientGuid(ref Guid guid); void ClearClientData(); void SetFilter(IntPtr filter);
        void GetResults(out IntPtr items); void GetSelectedItems(out IntPtr items);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result); void GetParent(out IShellItem parent); void GetDisplayName(uint name, out IntPtr value); void GetAttributes(uint mask, out uint attributes); void Compare(IShellItem other, uint hint, out int order);
    }
}
