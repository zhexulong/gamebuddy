namespace GameBuddy.Desktop;

internal enum DesktopLaunchResult
{
    Unavailable,
    RegistrationReady,
}

internal static class Program
{
    private static async Task Main()
    {
        await RunForTestingAsync(CancellationToken.None).ConfigureAwait(false);
    }

    internal static Task<DesktopLaunchResult> RunForTestingAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            _ = CurrentUserRootLayout.DeriveForCurrentUser();
            return Task.FromResult(DesktopLaunchResult.RegistrationReady);
        }
        catch (RootRegistrationUnavailableException)
        {
            return Task.FromResult(DesktopLaunchResult.Unavailable);
        }
        catch (RootLayoutUnavailableException)
        {
            return Task.FromResult(DesktopLaunchResult.Unavailable);
        }
    }
}
