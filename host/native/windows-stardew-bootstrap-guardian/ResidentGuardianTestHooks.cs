using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;

namespace GameBuddy.WindowsStardewBootstrapGuardian;

#if GUARDIAN_TEST_HOOKS
/** Disposable test-variant barrier. Production builds compile no hook surface. */
internal static class ResidentGuardianTestHooks
{
    private const string BarrierDirectoryVariable = "GAMEBUDDY_GUARDIAN_TEST_BARRIER_DIRECTORY";
    private const string BarrierPhaseVariable = "GAMEBUDDY_GUARDIAN_TEST_BARRIER_PHASE";
    private static readonly string[] AllowedEnvironmentNames = ["SystemRoot", "TEMP", "TMP", "GAMEBUDDY_GUARDIAN_MODE", "GAMEBUDDY_GUARDIAN_CONTROL_PIPE", "GAMEBUDDY_GUARDIAN_CONTROL_TOKEN"];

    internal static bool TryObserveResidentEnvironmentAndWaitForEof()
    {
        var pipe = Environment.GetEnvironmentVariable("GAMEBUDDY_GUARDIAN_CONTROL_PIPE");
        if (string.IsNullOrWhiteSpace(pipe) || !pipe.StartsWith("GameBuddy.Guardian.TestObservation.", StringComparison.Ordinal)) return false;
        var environment = Environment.GetEnvironmentVariables().Keys.Cast<string>().OrderBy(name => name, StringComparer.Ordinal).ToArray();
        GetStartupInfo(out var startup);
        var stdinOnly = StringComparer.Ordinal.Equals(DescribeStandardHandle(startup.StdInput), "stdin");
        using (var observation = new NamedPipeClientStream(".", pipe, PipeDirection.Out, PipeOptions.None))
        {
            observation.Connect(5_000);
            using var writer = new StreamWriter(observation, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
            writer.WriteLine($"environment={string.Join(",", environment)}");
            writer.WriteLine($"allowed_environment={environment.SequenceEqual(AllowedEnvironmentNames.OrderBy(name => name, StringComparer.Ordinal), StringComparer.Ordinal).ToString().ToLowerInvariant()}");
            writer.WriteLine($"startup_stdin={DescribeStandardHandle(startup.StdInput)}");
            writer.WriteLine($"stdin_only={stdinOnly.ToString().ToLowerInvariant()}");
        }
        using var input = Console.OpenStandardInput();
        while (input.ReadByte() != -1) { }
        return true;
    }

    private static string DescribeStandardHandle(IntPtr handle) => handle == GetStdHandle(-10) ? "stdin" : $"unexpected:0x{handle.ToInt64():x}";

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo { internal uint Size; internal IntPtr Reserved, Desktop, Title; internal uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags; internal ushort ShowWindow, Reserved2; internal IntPtr Reserved2Pointer, StdInput, StdOutput, StdError; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern void GetStartupInfo(out StartupInfo startupInfo);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int standardHandle);

    internal static void Wait(string phase)
    {
        var directory = Environment.GetEnvironmentVariable(BarrierDirectoryVariable);
        var selectedPhase = Environment.GetEnvironmentVariable(BarrierPhaseVariable);
        if (string.IsNullOrWhiteSpace(directory) && string.IsNullOrWhiteSpace(selectedPhase)) return;
        if (string.IsNullOrWhiteSpace(directory) || selectedPhase is not ("before-create" or "after-create" or "after-membership" or "before-resume")) throw GuardianProtocol.Invalid();
        if (!StringComparer.Ordinal.Equals(selectedPhase, phase)) return;
        if (!Path.IsPathFullyQualified(directory)) throw GuardianProtocol.Invalid();
        var ready = Path.Combine(directory, $"{phase}.ready");
        var release = Path.Combine(directory, $"{phase}.release");
        File.WriteAllText(ready, phase);
        var deadline = Environment.TickCount64 + 15_000;
        while (!File.Exists(release))
        {
            if (Environment.TickCount64 >= deadline) throw GuardianProtocol.Invalid();
            Thread.Sleep(5);
        }
    }
}
#endif
