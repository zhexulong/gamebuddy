namespace GameBuddy.Desktop;

internal enum DesktopLaunchResult
{
    // The production entry's no-claim value: the admitted Host session ran to its
    // end without a named failure. Every failure has its own member below, so the
    // process can name what went wrong instead of looking like a success.
    Unavailable,
    RegistrationReady,
    HostStarted,
    GuardianStarted,
    RootRegistrationUnavailable,
    RootLayoutUnavailable,
    HostGenerationUnavailable,
    GenerationAdmissionRefused,
    GuardianLaunchUnavailable,
    HostSessionFailed,
}

internal static class Program
{
    private const string UnattributedLaunchFailureCode = "desktop_launch_failed";

    private static async Task<int> Main()
    {
        try
        {
            var outcomeCode = OutcomeCode(await RunProductionAsync(CancellationToken.None).ConfigureAwait(false));
            // A launch that named no failure keeps today's behaviour: silent, 0.
            if (outcomeCode is null) return 0;
            Console.Error.WriteLine(outcomeCode);
            return 1;
        }
        catch (Exception)
        {
            // An unexpected failure is a failed launch too. The runtime's own
            // report would be a stack trace, which can carry installed paths onto
            // the one channel the launcher reads, so it is replaced by one code.
            Console.Error.WriteLine(UnattributedLaunchFailureCode);
            return 1;
        }
    }

    /// <summary>
    /// The entry's entire observable result: the exit status, and at most one
    /// bounded outcome-code line on stderr naming how the launch ended. A code is
    /// always accompanied by a non-zero exit status, and the line carries no path,
    /// no secret and no stack.
    /// </summary>
    private static string? OutcomeCode(DesktopLaunchResult result) => result switch
    {
        DesktopLaunchResult.Unavailable => null,
        DesktopLaunchResult.RootRegistrationUnavailable => "root_registration_unavailable",
        DesktopLaunchResult.RootLayoutUnavailable => "root_layout_unavailable",
        DesktopLaunchResult.HostGenerationUnavailable => "host_generation_unavailable",
        DesktopLaunchResult.GenerationAdmissionRefused => "generation_admission_refused",
        DesktopLaunchResult.GuardianLaunchUnavailable => "guardian_launch_unavailable",
        DesktopLaunchResult.HostSessionFailed => "host_session_failed",
        _ => UnattributedLaunchFailureCode,
    };

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

    /// <summary>
    /// The step whose failure ended a launch. Registration and layout failures
    /// arrive as their own exception types; every other step fails with the
    /// admitted-child launch exception, so the entry records where it was in
    /// order to name them apart.
    /// </summary>
    private enum LaunchStage { GenerationSelection, GenerationAdmission, ChildLaunch, HostSession }

    private static async Task<DesktopLaunchResult> RunProductionAsync(CancellationToken cancellationToken)
    {
        var stage = LaunchStage.GenerationSelection;
        try
        {
            var layout = CurrentUserRootLayout.DeriveForCurrentUser();
            await using var selection = InstalledGenerationSelection.Acquire(layout.ProgramRoot);
            stage = LaunchStage.GenerationAdmission;
            await using var runtime = new InstalledHostRuntimeAdmission().Admit(selection);
            await using var image = await new InstalledGenerationAdmission(layout).AdmitGuardianAsync(selection, cancellationToken).ConfigureAwait(false);
            await using var runtimeSupervisor = new RuntimeSupervisor();
            await using var guardianSupervisor = new GuardianSupervisor();

            // From here the admitted children are launched: Voice first (the Host
            // child is handed its port/token pair), then the Host runtime and the
            // resident Guardian that attaches to its authenticated broker.
            stage = LaunchStage.ChildLaunch;

            // Voice is an optional capability: the coordinator resolves null
            // (no admitted artifact, consent not accepted, or unreadable
            // preference) and the composition stays on pure-text Chat. When it
            // resolves, the same loopback port/token pair goes into both the
            // Voice child and the exact Host child so the Host wire can reach it.
            var voiceLaunch = VoiceLaunchCoordinator.Resolve(
                selection.GenerationRoot,
                selection.Generation,
                selection.InventoryDigest,
                Path.Combine(layout.DataRoot, "settings", "player-preference.json"));
            await using var voiceSupervisor = voiceLaunch is null ? null : new VoiceGatewaySupervisor();
            VoiceGatewayLease? voiceLease = null;
            try
            {
                if (voiceLaunch is not null && voiceSupervisor is not null)
                {
                    var plan = VoiceGatewaySupervisor.BuildLaunchPlan(
                        runtime.RuntimePath,
                        voiceLaunch.Gateway,
                        voiceLaunch.Port,
                        voiceLaunch.Token,
                        cloudTtsAdmitted: true,
                        persona: null,
                        outputDevice: voiceLaunch.OutputDevice);
                    voiceLease = await voiceSupervisor.StartAsync(plan, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (GuardianLaunchUnavailableException)
            {
                // Voice child could not start: Host continues on pure text.
                voiceLease = null;
            }

            var hostOptions = new HostBootstrapEnvironmentOptions
            {
                VoicePort = voiceLease is null ? null : voiceLaunch!.Port,
                VoiceToken = voiceLease is null ? null : voiceLaunch!.Token,
            };
            await using var host = await runtimeSupervisor.StartHostAsync(selection, runtime, layout, cancellationToken, hostOptions).ConfigureAwait(false);
            stage = LaunchStage.HostSession;
            // The authenticated Host broker session is the only thing that may
            // ask for a recovery, and the image admitted for this generation is
            // the only image it may launch. Mounting binds those two; it has to
            // happen before the resident Guardian starts the broker's command
            // loop, which is what serves a recovery request.
            host.AttachRecoveryLaunch(new RecoveryLaunchTrigger(image, guardianSupervisor));
            GuardianSupervisorLease? resident = null;
            try
            {
                resident = await guardianSupervisor.StartResidentAsync(image, cancellationToken).ConfigureAwait(false);
                await host.AttachResidentGuardianAsync(resident, cancellationToken).ConfigureAwait(false);
                resident = null;
            }
            finally
            {
                if (resident is not null) await resident.DisposeAsync().ConfigureAwait(false);
            }
            // The Host child owns the session: the entry is done when that exact
            // child has exited. A wait that could not reap it is a failed session
            // rather than one more silent success.
            if (!await host.WaitForExitAsync(cancellationToken).ConfigureAwait(false)) return DesktopLaunchResult.HostSessionFailed;
            return DesktopLaunchResult.Unavailable;
        }
        catch (GuardianLaunchUnavailableException)
        {
            return stage switch
            {
                LaunchStage.GenerationSelection => DesktopLaunchResult.HostGenerationUnavailable,
                LaunchStage.GenerationAdmission => DesktopLaunchResult.GenerationAdmissionRefused,
                LaunchStage.ChildLaunch => DesktopLaunchResult.GuardianLaunchUnavailable,
                _ => DesktopLaunchResult.HostSessionFailed,
            };
        }
        catch (RootRegistrationUnavailableException) { return DesktopLaunchResult.RootRegistrationUnavailable; }
        catch (RootLayoutUnavailableException) { return DesktopLaunchResult.RootLayoutUnavailable; }
    }
}
