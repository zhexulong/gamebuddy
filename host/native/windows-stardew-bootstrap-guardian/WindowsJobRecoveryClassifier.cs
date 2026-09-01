using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Security.AccessControl;
using System.Security.Principal;

namespace GameBuddy.WindowsStardewBootstrapGuardian;

/** Recovery-only classifier. It opens only an exact post-CAS named Job and never creates or adopts one. */
internal static class WindowsJobRecoveryClassifier
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectBasicAccountingInformation = 1;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    private const uint JobObjectLimitBreakawayOk = 0x0800;
    private const uint JobObjectLimitSilentBreakawayOk = 0x1000;
    private const uint ErrorFileNotFound = 2;
    private const uint ErrorAccessDenied = 5;
    private const uint JobAccessTerminate = 0x0008;
    private const uint JobAccessQuery = 0x0004;
    private const uint JobAccessSynchronize = 0x00100000;
    private const uint ReadControl = 0x00020000;
    private const uint SeKernelObject = 6;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint RequiredAccess = JobAccessTerminate | JobAccessQuery | JobAccessSynchronize | ReadControl;

    internal static void ValidateAbi()
    {
        if (IntPtr.Size != 8 || Marshal.SizeOf<ExtendedLimitInformation>() != 144 || Marshal.SizeOf<BasicAccountingInformation>() != 48)
            throw new PlatformNotSupportedException("windows_stardew_bootstrap_guardian_recovery_job_abi_invalid");
    }

    internal static string Classify(string name, string durableState)
    {
        if (durableState == "contained") return "contained";
        if (durableState == "reserved") return "quarantined";
        if (durableState is not ("armed" or "active" or "closing")) return "quarantined";
        var job = OpenJobObjectW(RequiredAccess, false, name);
        if (job.IsInvalid)
        {
            var error = (uint)Marshal.GetLastWin32Error();
            job.Dispose();
            if (error != ErrorFileNotFound) return "quarantined";
            // A missing name is accepted only after a bounded fresh exact recheck.
            Thread.Sleep(20);
            job = OpenJobObjectW(RequiredAccess, false, name);
            if (job.IsInvalid)
            {
                error = (uint)Marshal.GetLastWin32Error();
                job.Dispose();
                return error == ErrorFileNotFound ? "contained" : "quarantined";
            }
        }
        try
        {
            if (!VerifyJob(job)) return "quarantined";
            if (!Drain(job)) return "quarantined";
            return "contained";
        }
        catch { return "quarantined"; }
        finally { job.Dispose(); }
    }

    private static bool VerifyJob(SafeFileHandle job)
    {
        var limits = new ExtendedLimitInformation();
        if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf<ExtendedLimitInformation>(), out _)) return false;
        var flags = limits.BasicLimitInformation.LimitFlags;
        var dacl = HasExpectedCurrentUserDacl(job);
        return (flags & JobObjectLimitKillOnJobClose) != 0 && (flags & (JobObjectLimitBreakawayOk | JobObjectLimitSilentBreakawayOk)) == 0 && dacl;
    }

    private static bool HasExpectedCurrentUserDacl(SafeFileHandle job)
    {
        var sid = WindowsIdentity.GetCurrent().User;
        if (sid is null) return false;
        if (GetSecurityInfo(job, SeKernelObject, DaclSecurityInformation, out _, out _, out _, out _, out var descriptor) != 0 || descriptor == IntPtr.Zero) return false;
        try
        {
            var length = GetSecurityDescriptorLength(descriptor);
            if (length == 0 || length > 64 * 1024) return false;
            var bytes = new byte[length];
            Marshal.Copy(descriptor, bytes, 0, checked((int)length));
            var security = new RawSecurityDescriptor(bytes, 0);
            if ((security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || security.DiscretionaryAcl is not { Count: 1 } dacl) return false;
            if (dacl[0] is not CommonAce ace || ace.AceQualifier != AceQualifier.AccessAllowed || ace.IsInherited) return false;
            return ace.AccessMask == checked((int)RequiredAccess) && sid.Equals(ace.SecurityIdentifier);
        }
        catch { return false; }
        finally { LocalFree(descriptor); }
    }

    private static bool Drain(SafeFileHandle job)
    {
        if (!HasActiveProcesses(job, out var active)) return false;
        if (active == 0) return true;
        if (!TerminateJobObject(job, 1)) return false;
        if (WaitForSingleObject(job, 30_000) != 0) return false;
        return HasActiveProcesses(job, out active) && active == 0;
    }

    private static bool HasActiveProcesses(SafeFileHandle job, out uint count)
    {
        var accounting = new BasicAccountingInformation();
        if (!QueryInformationJobObjectAccounting(job, JobObjectBasicAccountingInformation, ref accounting, (uint)Marshal.SizeOf<BasicAccountingInformation>(), out _)) { count = 0; return false; }
        count = accounting.ActiveProcesses;
        return true;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle OpenJobObjectW(uint desiredAccess, bool inheritHandle, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, uint infoClass, ref ExtendedLimitInformation info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")] private static extern bool QueryInformationJobObjectAccounting(SafeFileHandle job, uint infoClass, ref BasicAccountingInformation info, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint securityInformation, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimitInformation { internal BasicLimitInformation BasicLimitInformation; internal IO_COUNTERS Io; internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimitInformation { internal long PerProcessUserTimeLimit, PerJobUserTimeLimit; internal uint LimitFlags; internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicAccountingInformation { internal long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; internal uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
}
