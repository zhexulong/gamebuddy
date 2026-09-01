using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

internal static class RoleRootFixture
{
    public static int Main(string[] args)
    {
        // This is deliberately the fixture's first executable action: prove the
        // creation-time job-list association before parsing any test arguments.
        var member = IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out var inJob) && inJob;
        string? report = null;
        string? heartbeat = null;
        string? heldMutex = null;
        string? heldJob = null;
        string? probeJobDelete = null;
        string? recoveryJobName = null;
        string? recoveryJobMode = null;
        var childMode = false;
        var spawnDescendant = false;
        var exitAfterReport = false;
        var environmentReport = false;
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index] == "--signal" && index + 1 < args.Length) { report = args[++index]; continue; }
            if (args[index] == "--heartbeat" && index + 1 < args.Length) { heartbeat = args[++index]; continue; }
            if (args[index] == "--hold-mutex" && index + 1 < args.Length) { heldMutex = args[++index]; continue; }
            if (args[index] == "--hold-job" && index + 1 < args.Length) { heldJob = args[++index]; continue; }
            if (args[index] == "--probe-job-delete" && index + 1 < args.Length) { probeJobDelete = args[++index]; continue; }
            if (args[index] == "--recovery-job" && index + 2 < args.Length) { recoveryJobName = args[++index]; recoveryJobMode = args[++index]; continue; }
            if (args[index] == "--spawn-descendant") { spawnDescendant = true; continue; }
            if (args[index] == "--child") { childMode = true; continue; }
            if (args[index] == "--exit-after-report") { exitAfterReport = true; continue; }
            if (args[index] == "--environment-report") { environmentReport = true; continue; }
            return 2;
        }
        using var mutex = heldMutex is null ? null : CreateMutex(heldMutex);
        using var job = heldJob is null ? null : CreateJob(heldJob);
        using var recoveryJob = recoveryJobName is null ? null : CreateRecoveryJob(recoveryJobName, recoveryJobMode!);
        if (report is not null)
        {
            var content = $"member={member.ToString().ToLowerInvariant()}\n";
            if (environmentReport)
            {
                var controlsPresent = Environment.GetEnvironmentVariable("GAMEBUDDY_GUARDIAN_CONTROL_PIPE") is not null ||
                    Environment.GetEnvironmentVariable("GAMEBUDDY_GUARDIAN_CONTROL_TOKEN") is not null;
                content += $"guardian_control_environment={controlsPresent.ToString().ToLowerInvariant()}\n";
            }
            if (probeJobDelete is not null)
            {
                using var deleteHandle = OpenJobObjectW(DeleteAccess, false, probeJobDelete);
                content += $"job_delete_granted={(!deleteHandle.IsInvalid).ToString().ToLowerInvariant()}\n";
            }
            File.WriteAllText(report, content);
        }
        if (exitAfterReport) return 0;
        if (spawnDescendant)
        {
            var start = new System.Diagnostics.ProcessStartInfo(Environment.ProcessPath!);
            start.ArgumentList.Add("--child");
            if (heartbeat is not null) { start.ArgumentList.Add("--heartbeat"); start.ArgumentList.Add(heartbeat + ".child"); }
            start.UseShellExecute = false;
            using var descendant = System.Diagnostics.Process.Start(start);
        }
        var deadline = Environment.TickCount64 + 30_000;
        while (Environment.TickCount64 < deadline)
        {
            if (heartbeat is not null) File.WriteAllText(heartbeat, Environment.TickCount64.ToString(System.Globalization.CultureInfo.InvariantCulture));
            Thread.Sleep(childMode ? 40 : 50);
        }
        return 0;
    }

    private static SafeFileHandle CreateMutex(string name)
    {
        var mutex = CreateMutexW(IntPtr.Zero, true, name);
        if (mutex.IsInvalid || Marshal.GetLastWin32Error() == 183) throw new Win32Exception(Marshal.GetLastWin32Error());
        return mutex;
    }

    private static SafeFileHandle CreateJob(string name)
    {
        var job = CreateJobObjectW(IntPtr.Zero, name);
        if (job.IsInvalid || Marshal.GetLastWin32Error() == 183) throw new Win32Exception(Marshal.GetLastWin32Error());
        return job;
    }

    private static SafeFileHandle CreateRecoveryJob(string name, string mode)
    {
        var sid = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException();
        var flags = mode switch
        {
            "valid" or "valid-empty" or "wrong-dacl" or "deny-current" => JobObjectLimitKillOnClose,
            "no-kill" => 0u,
            "breakaway" => JobObjectLimitKillOnClose | JobObjectLimitBreakawayOk,
            _ => throw new ArgumentException(),
        };
        var dacl = mode switch
        {
            "wrong-dacl" => $"D:P(A;;0x0012000C;;;{sid})(A;;0x00100000;;;SY)",
            "deny-current" => "D:P",
            _ => $"D:P(A;;0x0012000C;;;{sid})",
        };
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(dacl, 1, out var descriptor, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var attributes = new SecurityAttributes { nLength = Marshal.SizeOf<SecurityAttributes>(), lpSecurityDescriptor = descriptor, bInheritHandle = 0 };
            var job = CreateJobObjectW(ref attributes, name);
            if (job.IsInvalid || Marshal.GetLastWin32Error() == ErrorAlreadyExists) { job.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            var limits = new ExtendedLimitInformation { BasicLimitInformation = new BasicLimitInformation { LimitFlags = flags } };
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf<ExtendedLimitInformation>()) || (mode != "valid-empty" && !AssignProcessToJobObject(job, GetCurrentProcess()))) { job.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            return job;
        }
        finally { LocalFree(descriptor); }
    }

    private const uint DeleteAccess = 0x00010000;
    private const uint ErrorAlreadyExists = 183;
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnClose = 0x2000;
    private const uint JobObjectLimitBreakawayOk = 0x0800;

    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateMutexW(IntPtr attributes, bool initialOwner, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObjectW(ref SecurityAttributes attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, uint infoClass, ref ExtendedLimitInformation info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle OpenJobObjectW(uint desiredAccess, bool inheritHandle, string name);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr securityDescriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { internal int nLength; internal IntPtr lpSecurityDescriptor; internal int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimitInformation { internal BasicLimitInformation BasicLimitInformation; internal IoCounters Io; internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimitInformation { internal long PerProcessUserTimeLimit, PerJobUserTimeLimit; internal uint LimitFlags; internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
}
