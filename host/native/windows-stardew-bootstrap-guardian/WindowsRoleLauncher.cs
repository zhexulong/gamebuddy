using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace GameBuddy.WindowsStardewBootstrapGuardian;

internal sealed class WindowsRoleLauncher
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const int ProcThreadAttributeJobList = 0x0002000D;
    private const uint ProcThreadAttributeInput = 1;

    internal static void ValidateAbi()
    {
        if (IntPtr.Size != 8 || Marshal.SizeOf<STARTUPINFO>() != 104 || Marshal.SizeOf<STARTUPINFOEX>() != 112 || Marshal.SizeOf<PROCESS_INFORMATION>() != 24)
            throw new PlatformNotSupportedException("windows_stardew_bootstrap_guardian_role_abi_invalid");
    }

    internal static LaunchedRole CreateSuspendedRole(WindowsJobOwner job, string executable, IReadOnlyList<string> arguments, string? cwd, IReadOnlyDictionary<string, string>? environment)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var startup = new STARTUPINFOEX { StartupInfo = new STARTUPINFO() { cb = (uint)Marshal.SizeOf<STARTUPINFOEX>() } };
        nuint attributeBytes = 0;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
        if (attributeBytes == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        startup.lpAttributeList = Marshal.AllocHGlobal((nint)attributeBytes);
        var process = SafeKernelHandle.Invalid;
        var thread = SafeKernelHandle.Invalid;
        try
        {
            if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, ref attributeBytes)) throw new Win32Exception(Marshal.GetLastWin32Error(), "windows_stardew_bootstrap_guardian_attribute_list_init_failed");
            var jobs = new[] { job.Handle };
            var jobsPtr = Marshal.AllocHGlobal(IntPtr.Size);
            try
            {
                Marshal.WriteIntPtr(jobsPtr, jobs[0]);
                if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, (nuint)ProcThreadAttributeJobList, jobsPtr, (nuint)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "windows_stardew_bootstrap_guardian_job_attribute_failed");
                var commandLine = new System.Text.StringBuilder(BuildCommandLine(executable, arguments));
                var environmentBlock = BuildEnvironment(environment);
                try
                {
                    var created = CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent, environmentBlock, cwd, ref startup, out var processInfo);
                    if (!created) throw new Win32Exception(Marshal.GetLastWin32Error(), "windows_stardew_bootstrap_guardian_role_create_failed");
                    process = new SafeKernelHandle(processInfo.hProcess, true); thread = new SafeKernelHandle(processInfo.hThread, true);
                    return new LaunchedRole(process, thread);
                }
                finally { if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock); }
            }
            finally { Marshal.FreeHGlobal(jobsPtr); }
        }
        catch
        {
            if (!process.IsInvalid) TerminateProcess(process, 1);
            process.Dispose(); thread.Dispose(); throw;
        }
        finally
        {
            if (startup.lpAttributeList != IntPtr.Zero) { DeleteProcThreadAttributeList(startup.lpAttributeList); Marshal.FreeHGlobal(startup.lpAttributeList); }
        }
    }

    internal static void VerifyMembership(LaunchedRole role, WindowsJobOwner job)
    {
        if (!IsProcessInJob(role.Process, job.Handle)) throw new InvalidOperationException("windows_stardew_bootstrap_guardian_membership_failed");
    }

    internal static void Resume(LaunchedRole role) { if (ResumeThread(role.Thread) == uint.MaxValue) { TerminateProcess(role.Process, 1); throw new Win32Exception(Marshal.GetLastWin32Error()); } }

    private static string BuildCommandLine(string executable, IReadOnlyList<string> arguments) =>
        string.Join(" ", new[] { QuoteForWindowsCrt(executable) }.Concat(arguments.Select(QuoteForWindowsCrt)));

    private static string QuoteForWindowsCrt(string value)
    {
        if (value.IndexOf('\0') >= 0) throw new InvalidDataException("windows_stardew_bootstrap_guardian_argument_invalid");
        var builder = new System.Text.StringBuilder(value.Length + 2);
        builder.Append('"');
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            builder.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            builder.Append(character);
            slashes = 0;
        }
        builder.Append('\\', slashes * 2);
        builder.Append('"');
        return builder.ToString();
    }

    private static IntPtr BuildEnvironment(IReadOnlyDictionary<string, string>? environment)
    {
        if (environment is null || environment.Count == 0) throw new InvalidDataException("windows_stardew_bootstrap_guardian_environment_missing");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var entries = environment.Select(pair =>
        {
            if (pair.Key.Length == 0 || pair.Key.Contains('\0') || pair.Key.Contains('=') || pair.Value.Contains('\0') ||
                pair.Key.StartsWith("GAMEBUDDY_GUARDIAN_CONTROL_", StringComparison.OrdinalIgnoreCase) || pair.Key.Equals("GAMEBUDDY_GUARDIAN_MODE", StringComparison.OrdinalIgnoreCase) || !seen.Add(pair.Key))
                throw new InvalidDataException("windows_stardew_bootstrap_guardian_environment_invalid");
            return pair;
        }).OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).ThenBy(pair => pair.Key, StringComparer.Ordinal);
        return Marshal.StringToHGlobalUni(string.Join('\0', entries.Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0");
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref nuint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, nuint attribute, IntPtr value, nuint size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string applicationName, System.Text.StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string? currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(SafeKernelHandle thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(SafeKernelHandle process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(SafeKernelHandle process, IntPtr job, out bool result);
    private static bool IsProcessInJob(SafeKernelHandle process, IntPtr job) => IsProcessInJob(process, job, out var result) && result;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO { internal uint cb; internal IntPtr lpReserved; internal string? lpDesktop, lpTitle; internal uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; internal ushort wShowWindow, cbReserved2; internal IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] private struct STARTUPINFOEX { internal STARTUPINFO StartupInfo; internal IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { internal IntPtr hProcess, hThread; internal uint dwProcessId, dwThreadId; }
    internal sealed class LaunchedRole : IDisposable
    {
        internal SafeKernelHandle Process { get; }
        internal SafeKernelHandle Thread { get; }
        internal LaunchedRole(SafeKernelHandle process, SafeKernelHandle thread) { Process = process; Thread = thread; }
        internal void Abort() { if (!Process.IsInvalid) TerminateProcess(Process, 1); Dispose(); }
        public void Dispose() { Thread.Dispose(); Process.Dispose(); }
    }
    internal sealed class SafeKernelHandle : SafeHandleZeroOrMinusOneIsInvalid { internal static SafeKernelHandle Invalid => new(IntPtr.Zero, false); internal SafeKernelHandle() : base(true) { } internal SafeKernelHandle(IntPtr value, bool owns) : base(owns) => SetHandle(value); protected override bool ReleaseHandle() => CloseHandle(handle); [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle); }
}
