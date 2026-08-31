using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Security.Principal;

namespace GameBuddy.WindowsStardewBootstrapGuardian;

internal sealed class GuardianLease : IDisposable
{
    private readonly SafeFileHandle handle;
    private bool disposed;

    private GuardianLease(SafeFileHandle handle) => this.handle = handle;
    internal static GuardianLease Create(string name)
    {
        ValidateName(name);
        using var security = SecurityDescriptor.CreateCurrentUserAttributes();
        var attributes = security.Attributes;
        var mutex = CreateMutexW(ref attributes, true, name);
        var createError = Marshal.GetLastWin32Error();
        if (mutex.IsInvalid) throw new Win32Exception(createError);
        if (createError == 183)
        {
            mutex.Dispose();
            throw new InvalidOperationException("windows_stardew_bootstrap_guardian_lease_name_collision");
        }
        return new GuardianLease(mutex);
    }

    private static void ValidateName(string name)
    {
        if (!name.StartsWith("Local\\", StringComparison.Ordinal) || name.Length > 140 || name[6..].Length == 0 ||
            name[6..].Any(c => !char.IsLetterOrDigit(c) && c is not ('-' or '_')))
            throw new InvalidDataException("windows_stardew_bootstrap_guardian_lease_name_invalid");
    }

    public void Dispose()
    {
        if (!disposed) { disposed = true; handle.Dispose(); }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateMutexW(ref WindowsJobOwner.SECURITY_ATTRIBUTES attributes, bool initialOwner, string name);

    internal static class SecurityDescriptor
    {
        internal sealed class Reference : IDisposable
        {
            internal WindowsJobOwner.SECURITY_ATTRIBUTES Attributes;
            internal Reference(WindowsJobOwner.SECURITY_ATTRIBUTES attributes) => Attributes = attributes;
            public void Dispose() { if (Attributes.lpSecurityDescriptor != IntPtr.Zero) LocalFree(Attributes.lpSecurityDescriptor); }
        }

        internal static Reference CreateCurrentUserAttributes()
        {
            var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("windows_stardew_bootstrap_guardian_current_sid_missing");
            // MUTEX_MODIFY_STATE | SYNCHRONIZE. Creation is protected by this DACL;
            // CreateMutexW may return a broader creator handle, but no broader ACL is published.
            var sddl = $"D:P(A;;0x00100001;;;{sid})";
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out var descriptor, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new Reference(new WindowsJobOwner.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<WindowsJobOwner.SECURITY_ATTRIBUTES>(), lpSecurityDescriptor = descriptor, bInheritHandle = 0 });
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    }
}
