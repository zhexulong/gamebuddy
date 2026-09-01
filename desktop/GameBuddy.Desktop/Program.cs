namespace GameBuddy.Desktop;

internal enum DesktopLaunchResult
{
    Unavailable,
    RegistrationReady,
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
            await using var image = await new InstalledGenerationAdmission(layout).AdmitGuardianAsync(cancellationToken).ConfigureAwait(false);
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

    private static async Task<DesktopLaunchResult> RunProductionAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using var image = await InstalledGenerationAdmission.FromCurrentUserRegistration().AdmitGuardianAsync(cancellationToken).ConfigureAwait(false);
            await using var supervisor = new GuardianSupervisor();
            await using var lease = await supervisor.StartResidentAsync(image, cancellationToken).ConfigureAwait(false);
            _ = await lease.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            return DesktopLaunchResult.GuardianStarted;
        }
        catch (GuardianLaunchUnavailableException)
        {
            return DesktopLaunchResult.Unavailable;
        }
        catch (RootRegistrationUnavailableException)
        {
            return DesktopLaunchResult.Unavailable;
        }
        catch (RootLayoutUnavailableException)
        {
            return DesktopLaunchResult.Unavailable;
        }
    }
}
