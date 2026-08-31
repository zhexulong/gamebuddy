using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Runtime.InteropServices;

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
            if (args[index] == "--spawn-descendant") { spawnDescendant = true; continue; }
            if (args[index] == "--child") { childMode = true; continue; }
            if (args[index] == "--exit-after-report") { exitAfterReport = true; continue; }
            if (args[index] == "--environment-report") { environmentReport = true; continue; }
            return 2;
        }
        using var mutex = heldMutex is null ? null : CreateMutex(heldMutex);
        using var job = heldJob is null ? null : CreateJob(heldJob);
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

    private const uint DeleteAccess = 0x00010000;

    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateMutexW(IntPtr attributes, bool initialOwner, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle OpenJobObjectW(uint desiredAccess, bool inheritHandle, string name);
}
