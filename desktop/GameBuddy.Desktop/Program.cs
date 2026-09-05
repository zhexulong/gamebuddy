namespace GameBuddy.Desktop;

internal enum DesktopLaunchResult
{
    Unavailable,
    RegistrationReady,
    HostStarted,
    GuardianStarted,
}

internal static class Program
{
    private static async Task Main()
    {
        _ = await RunProductionAsync(CancellationToken.None).ConfigureAwait(false);
    }

    internal static async Task<DesktopLaunchResult> RunForTestingAsync(ICurrentUserRootRegistrationReader registrationReader, ILocalApplicationDataProvider localApplicationDataProvider, GuardianSupervisor supervisor, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(registrationReader);
        ArgumentNullException.ThrowIfNull(localApplicationDataProvider);
        ArgumentNullException.ThrowIfNull(supervisor);
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            var layout = CurrentUserRootLayout.DeriveForTesting(registrationReader, localApplicationDataProvider);
            await using var selection = InstalledGenerationSelection.Acquire(layout.ProgramRoot);
            await using var runtime = new InstalledHostRuntimeAdmission().Admit(selection);
            await using var image = await new InstalledGenerationAdmission(layout).AdmitGuardianAsync(selection, cancellationToken).ConfigureAwait(false);
            await using var lease = await supervisor.StartResidentAsync(image, cancellationToken).ConfigureAwait(false);
            await lease.CloseControlAsync(cancellationToken).ConfigureAwait(false);
            return await lease.WaitForExitAsync(cancellationToken).ConfigureAwait(false) is GuardianSupervisorExit.ControlClosed
                ? DesktopLaunchResult.GuardianStarted
                : DesktopLaunchResult.Unavailable;
        }
        catch (GuardianLaunchUnavailableException) { return DesktopLaunchResult.Unavailable; }
        catch (RootRegistrationUnavailableException) { return DesktopLaunchResult.Unavailable; }
        catch (RootLayoutUnavailableException) { return DesktopLaunchResult.Unavailable; }
    }

    internal static async Task<DesktopLaunchResult> RunHostForTestingAsync(CurrentUserRootLayout layout, RuntimeSupervisor supervisor, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(supervisor);
        try
        {
            await using var selection = InstalledGenerationSelection.Acquire(layout.ProgramRoot);
            await using var runtime = new InstalledHostRuntimeAdmission().Admit(selection);
            await using var lease = await supervisor.StartHostAsync(selection, runtime, layout, cancellationToken).ConfigureAwait(false);
            return DesktopLaunchResult.HostStarted;
        }
        catch (GuardianLaunchUnavailableException) { return DesktopLaunchResult.Unavailable; }
    }

    private static async Task<DesktopLaunchResult> RunProductionAsync(CancellationToken cancellationToken)
    {
        try
        {
            var layout = CurrentUserRootLayout.DeriveForCurrentUser();
            await using var selection = InstalledGenerationSelection.Acquire(layout.ProgramRoot);
            await using var runtime = new InstalledHostRuntimeAdmission().Admit(selection);
            await using var image = await new InstalledGenerationAdmission().AdmitGuardianAsync(selection, cancellationToken).ConfigureAwait(false);
            await using var runtimeSupervisor = new RuntimeSupervisor();
            await using var guardianSupervisor = new GuardianSupervisor();
            await using var host = await runtimeSupervisor.StartHostAsync(selection, runtime, layout, cancellationToken,
                recoveryCancellationToken => guardianSupervisor.StartRecoveryAsync(image, recoveryCancellationToken)).ConfigureAwait(false);
            await using var guardian = await guardianSupervisor.StartResidentAsync(image, cancellationToken).ConfigureAwait(false);
            await host.AttachResidentGuardianAsync(guardian, cancellationToken).ConfigureAwait(false);
            _ = await guardian.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            return DesktopLaunchResult.GuardianStarted;
        }
        catch (GuardianLaunchUnavailableException) { return DesktopLaunchResult.Unavailable; }
        catch (RootRegistrationUnavailableException) { return DesktopLaunchResult.Unavailable; }
        catch (RootLayoutUnavailableException) { return DesktopLaunchResult.Unavailable; }
    }
}
