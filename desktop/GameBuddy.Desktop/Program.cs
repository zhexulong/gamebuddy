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
    // The launcher-owned pre-launch provisioning step could not establish the
    // layout's mutable roots. It is named apart from RootLayoutUnavailable because
    // the event is different: creating the roots failed, not deriving a layout.
    MutableRootsUnavailable,
    HostGenerationUnavailable,
    GenerationAdmissionRefused,
    GuardianLaunchUnavailable,
    // The operational deployment manifest is absent or unusable and no identity
    // could be established for it: the launch can never enter Host composition. Its
    // own member, because the launcher neither supplies that identity nor may it
    // treat a missing one as a layout problem.
    DeploymentIdentityUnavailable,
    // Establishing the first deployment identity failed. Named apart from the member
    // above because the event is the opposite one: there was nothing to find, and the
    // single attempt to mint the first identity did not complete.
    DeploymentIdentityMintUnavailable,
    // The identity could not be read, written, or projected onto the operational
    // manifest - a durable record or filesystem failure, not a missing identity.
    DeploymentIdentityEstablishUnavailable,
    // An operational manifest and the durable identity record both exist and disagree.
    // Nothing is overwritten and neither side is chosen.
    DeploymentIdentityConflict,
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
    internal static string? OutcomeCode(DesktopLaunchResult result) => result switch
    {
        DesktopLaunchResult.Unavailable => null,
        DesktopLaunchResult.RootRegistrationUnavailable => "root_registration_unavailable",
        DesktopLaunchResult.RootLayoutUnavailable => "root_layout_unavailable",
        DesktopLaunchResult.MutableRootsUnavailable => "mutable_roots_unavailable",
        DesktopLaunchResult.HostGenerationUnavailable => "host_generation_unavailable",
        DesktopLaunchResult.GenerationAdmissionRefused => "generation_admission_refused",
        DesktopLaunchResult.GuardianLaunchUnavailable => "guardian_launch_unavailable",
        DesktopLaunchResult.DeploymentIdentityUnavailable => "deployment_identity_unavailable",
        DesktopLaunchResult.DeploymentIdentityMintUnavailable => "deployment_identity_mint_unavailable",
        DesktopLaunchResult.DeploymentIdentityEstablishUnavailable => "deployment_identity_establish_unavailable",
        DesktopLaunchResult.DeploymentIdentityConflict => "deployment_identity_conflict",
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
            // The launcher owns this step, before anything is launched and before the
            // generation is admitted. The data, operational and presentation roots are
            // derived rather than registered and no product component creates them, so
            // the first launch must or the layout read below fails closed. It is
            // idempotent, it creates only those directories, and it never creates the
            // program root (Setup installs that).
            CurrentUserRootLayout.ProvisionMutableRootsForCurrentUser();
            var layout = CurrentUserRootLayout.DeriveForCurrentUser();
            await using var selection = InstalledGenerationSelection.Acquire(layout.ProgramRoot);
            stage = LaunchStage.GenerationAdmission;
            await using var runtime = new InstalledHostRuntimeAdmission().Admit(selection);
            await using var image = await new InstalledGenerationAdmission(layout).AdmitGuardianAsync(selection, cancellationToken).ConfigureAwait(false);
            await using var runtimeSupervisor = new RuntimeSupervisor();
            await using var guardianSupervisor = new GuardianSupervisor();

            // The operational deployment manifest is the admitted Host child's
            // deployment identity. The manifest must exist before the child does,
            // because the supervisor requires that file and the Host reads it as
            // input, so a writer inside the child cannot produce it: this step
            // establishes the identity exactly once - minting it only when neither
            // the manifest nor the durable record exists, otherwise projecting the
            // durable record - and never overwrites an existing manifest.
            var mintedDeploymentIdentity = DeploymentIdentity.EstablishForCurrentUser(layout);

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
                // `fresh` creates the semantic authority and `known` opens the one that
                // already exists (host/src/composition/desktop-host-composition.ts:152).
                // Only the run that minted the deployment identity may ask for a fresh
                // authority: every later launch presents the identity the authority was
                // created with, so it opens it as known. The launcher previously never
                // set this and relied on the `fresh` default, which would have opened an
                // existing authority as fresh on the second launch.
                GameSessionMode = mintedDeploymentIdentity
                    ? HostBootstrapEnvironmentOptions.FreshGameSessionMode
                    : HostBootstrapEnvironmentOptions.KnownGameSessionMode,
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
        catch (MutableRootsUnavailableException) { return DesktopLaunchResult.MutableRootsUnavailable; }
        catch (DeploymentIdentityUnavailableException) { return DesktopLaunchResult.DeploymentIdentityUnavailable; }
        catch (DeploymentIdentityMintUnavailableException) { return DesktopLaunchResult.DeploymentIdentityMintUnavailable; }
        catch (DeploymentIdentityEstablishUnavailableException) { return DesktopLaunchResult.DeploymentIdentityEstablishUnavailable; }
        catch (DeploymentIdentityConflictException) { return DesktopLaunchResult.DeploymentIdentityConflict; }
    }
}
