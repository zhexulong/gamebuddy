using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace GameBuddy.WindowsStardewBootstrapGuardian;

internal sealed class WindowsJobOwner : IDisposable
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectBasicAccountingInformation = 1;
    private const uint JobObjectAssociateCompletionPortInformation = 7;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    private const uint JobObjectMsgActiveProcessZero = 4;
    private const uint Infinite = 0xFFFF_FFFF;
    private readonly SafeFileHandle handle;
    private readonly SafeFileHandle completionPort;
    private bool disposed;

    private WindowsJobOwner(SafeFileHandle handle, SafeFileHandle completionPort) { this.handle = handle; this.completionPort = completionPort; }
    internal IntPtr Handle => handle.DangerousGetHandle();

    internal static void ValidateAbi()
    {
        if (IntPtr.Size != 8 || Marshal.SizeOf<SECURITY_ATTRIBUTES>() != 24 || Marshal.SizeOf<ExtendedLimitInformation>() != 144 || Marshal.SizeOf<BasicAccountingInformation>() != 48 || Marshal.SizeOf<AssociateCompletionPort>() != 16)
            throw new PlatformNotSupportedException("windows_stardew_bootstrap_guardian_job_abi_invalid");
    }

    internal static WindowsJobOwner Create(string name)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        using var security = NativeSecurity.CreateCurrentUserAttributes();
        var attributes = security.Attributes;
        var job = CreateJobObjectW(ref attributes, name);
        var createError = Marshal.GetLastWin32Error();
        if (job.IsInvalid) throw new Win32Exception(createError);
        if (createError == 183) { job.Dispose(); throw new InvalidOperationException("windows_stardew_bootstrap_guardian_job_name_collision"); }
        var limits = new ExtendedLimitInformation { BasicLimitInformation = new BasicLimitInformation { LimitFlags = JobObjectLimitKillOnJobClose } };
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf<ExtendedLimitInformation>())) { job.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        var completionPort = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
        if (completionPort.IsInvalid) { job.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        var association = new AssociateCompletionPort { CompletionKey = (IntPtr)1, CompletionPort = completionPort.DangerousGetHandle() };
        if (!SetInformationJobObjectCompletionPort(job, JobObjectAssociateCompletionPortInformation, ref association, (uint)Marshal.SizeOf<AssociateCompletionPort>()))
        { completionPort.Dispose(); job.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        return new WindowsJobOwner(job, completionPort);
    }

    internal bool HasActiveProcesses(out uint count)
    {
        var accounting = new BasicAccountingInformation();
        if (!QueryInformationJobObject(handle, JobObjectBasicAccountingInformation, ref accounting, (uint)Marshal.SizeOf<BasicAccountingInformation>(), out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
        count = accounting.ActiveProcesses;
        return count != 0;
    }

    internal void TerminateAndDrain()
    {
        // The completion port is associated once at creation, before any process can join.
        // An already-empty job has no future ACTIVE_PROCESS_ZERO notification to wait for.
        var wasActive = HasActiveProcesses(out _);
        if (!wasActive) return;
        if (!TerminateJobObject(handle, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var deadline = Environment.TickCount64 + 30_000;
        var activeProcessZeroSignaled = false;
        while (true)
        {
            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0) throw new TimeoutException("windows_stardew_bootstrap_guardian_job_drain_timeout");
            if (!GetQueuedCompletionStatus(completionPort, out var message, out _, out var overlapped, (uint)Math.Min(remaining, int.MaxValue)))
            {
                if (overlapped == IntPtr.Zero && Marshal.GetLastWin32Error() == 258) throw new TimeoutException("windows_stardew_bootstrap_guardian_job_drain_timeout");
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            activeProcessZeroSignaled |= message == JobObjectMsgActiveProcessZero;
            if (activeProcessZeroSignaled && !HasActiveProcesses(out var count) && count == 0) return;
        }
    }

    public void Dispose() { if (!disposed) { disposed = true; completionPort.Dispose(); handle.Dispose(); } }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(ref SECURITY_ATTRIBUTES attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, uint infoClass, ref ExtendedLimitInformation info, uint length);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetInformationJobObject")] private static extern bool SetInformationJobObjectCompletionPort(SafeFileHandle job, uint infoClass, ref AssociateCompletionPort info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, uint infoClass, ref BasicAccountingInformation info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeFileHandle CreateIoCompletionPort(IntPtr fileHandle, IntPtr existingCompletionPort, UIntPtr completionKey, uint numberOfConcurrentThreads);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetQueuedCompletionStatus(SafeFileHandle completionPort, out uint numberOfBytes, out UIntPtr completionKey, out IntPtr overlapped, uint milliseconds);

    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimitInformation { internal BasicLimitInformation BasicLimitInformation; internal IO_COUNTERS Io; internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimitInformation { internal long PerProcessUserTimeLimit, PerJobUserTimeLimit; internal uint LimitFlags; internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicAccountingInformation { internal long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; internal uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] private struct AssociateCompletionPort { internal IntPtr CompletionKey, CompletionPort; }

    internal sealed class SecurityReference : IDisposable { internal SECURITY_ATTRIBUTES Attributes; internal SecurityReference(SECURITY_ATTRIBUTES attributes) => Attributes = attributes; public void Dispose() => NativeSecurity.Free(Attributes.lpSecurityDescriptor); }
    [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { internal int nLength; internal IntPtr lpSecurityDescriptor; internal int bInheritHandle; }

    private static class NativeSecurity
    {
        internal static SecurityReference CreateCurrentUserAttributes()
        {
            var sid = System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("windows_stardew_bootstrap_guardian_current_sid_missing");
        // Recovery requires only QUERY/TERMINATE/SYNCHRONIZE plus READ_CONTROL
        // to attest this fixed current-user DACL; DELETE and ACL mutation stay absent.
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW($"D:P(A;;0x0012000C;;;{sid})", 1, out var descriptor, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new SecurityReference(new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), lpSecurityDescriptor = descriptor, bInheritHandle = 0 });
        }
        internal static void Free(IntPtr descriptor) { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, out uint size);
        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    }
}
