namespace GameBuddy.WindowsStardewBootstrapGuardian;

#if GUARDIAN_TEST_HOOKS
/** Disposable test-variant barrier. Production builds compile no hook surface. */
internal static class ResidentGuardianTestHooks
{
    private const string BarrierDirectoryVariable = "GAMEBUDDY_GUARDIAN_TEST_BARRIER_DIRECTORY";
    private const string BarrierPhaseVariable = "GAMEBUDDY_GUARDIAN_TEST_BARRIER_PHASE";

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
