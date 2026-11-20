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
    // A second invocation of the product entry found a live primary instance and could not
    // deliver its one bounded open/focus intent. It names the fact instead of starting a
    // second Host: the presentation is the primary instance's to own.
    PrimaryInstanceUnavailable,
}

internal static class Program
{
    private const string UnattributedLaunchFailureCode = "desktop_launch_failed";
    private const string SubcommandFailed = "desktop_subcommand_failed";
    private const string RootUnavailable = "desktop_root_unavailable";

    private static async Task<int> Main(string[] args)
    {
        // `--rollback` steps back one generation and exits: it is a recovery action, not a second launch mode. Arguments are
        // matched exactly, so an unknown one still reaches the normal path rather than being silently accepted. Both
        // subcommands are outside the launch path, so they are outside its failure handling too - and a refusal there must
        // still be one bounded code rather than a stack trace on the channel a caller reads.
        if (args.Length == 1 && string.Equals(args[0], "--rollback", StringComparison.Ordinal))
        {
            return Bounded(SubcommandFailed, () => RollBack());
        }

        // `--check-update <source>` reports whether a newer release exists and exits. It fetches and validates a manifest and
        // stops: downloading and running an installer is a separate decision about what vouches for the bytes.
        if (args.Length == 2 && string.Equals(args[0], "--check-update", StringComparison.Ordinal))
        {
            return Bounded(SubcommandFailed, () => CheckUpdate(args[1]));
        }

        // `--apply-update <source>` is the half that changes the machine: download, verify the manifest's digest, stage atomically
        // and hand the installer off after this process exits. Separate from the check because the two deserve different
        // commands: one answers a question, the other replaces the running product.
        if (args.Length == 2 && string.Equals(args[0], "--apply-update", StringComparison.Ordinal))
        {
            return Bounded(SubcommandFailed, () => ApplyUpdate(args[1]));
        }

        try
        {
            var outcome = await RunProductionAsync(CancellationToken.None).ConfigureAwait(false);
            var outcomeCode = OutcomeCode(outcome);
            // A launch that named no failure keeps today's behaviour: silent, 0.
            if (outcomeCode is null) return 0;
            Console.Error.WriteLine(outcomeCode);
            // The player's own half of the same failure, BEFORE the entry returns: a process that has
            // returned leaves nothing on screen, and a double click on an `Exe` leaves a console window
            // that closes - so a failure the player cannot see is a failure nobody was told about.
            LaunchFailureWindow.Show(Record(outcome.Result, outcome.Reason, outcome.Stage, outcome.ChildStderr, TryOperationalRoot()));
            return 1;
        }
        catch (Exception)
        {
            // An unexpected failure is a failed launch too. The runtime's own
            // report would be a stack trace, which can carry installed paths onto
            // the one channel the launcher reads, so it is replaced by one code.
            Console.Error.WriteLine(UnattributedLaunchFailureCode);
            LaunchFailureWindow.Show(Record(DesktopLaunchResult.Unavailable, reason: null, stage: null, childCode: null, operationalRoot: TryOperationalRoot()));
            return 1;
        }
    }

    /// <summary>
    /// The two halves of telling the player a launch failed: the record written beside the ones the
    /// Host child writes, and the statement the window shows.
    ///
    /// The code the record carries is the most specific one the failure produced - the Host child's own
    /// when it named one, otherwise the category this launch step refused with - and the step is the one
    /// the child had announced. Neither is invented here: both are codes the Host already emits.
    /// </summary>
    internal static LaunchFailureNotice Record(
        DesktopLaunchResult result,
        string? reason,
        string? stage,
        string? childCode,
        string? operationalRoot)
    {
        var recordCode = DesktopLaunchFailureRecord.Bounded(childCode) ?? DesktopLaunchFailureRecord.Bounded(reason);
        var recordPath = DesktopLaunchFailureRecord.Write(operationalRoot, recordCode, stage, childCode);
        return LaunchFailureNotice.For(result, stage, childCode).WithRecord(recordPath);
    }

    /// <summary>
    /// The operational root a failed launch's record belongs in, or <c>null</c> when this machine cannot
    /// derive one - an account with nothing registered, or a layout that cannot be read. It is the same
    /// authority the production path uses and it runs only on a failure, where deriving it can never be
    /// allowed to become a second failure of its own.
    /// </summary>
    private static string? TryOperationalRoot()
    {
        try { return CurrentUserRootLayout.DeriveForCurrentUser().OperationalRoot; }
        catch (Exception) { return null; }
    }

    /// <summary>
    /// Downloads the newer release, verifies it against the manifest, stages it and starts the installer after this process
    /// exits. Every refusal is one bounded code, and nothing is executed that did not verify.
    /// </summary>
    private static int ApplyUpdate(string source)
    {
        var programRoot = InstalledProgramRoot();
        var result = UpdateInstaller
            .ApplyAsync(programRoot, source, CancellationToken.None)
            .GetAwaiter()
            .GetResult();
        switch (result.Outcome)
        {
            case UpdateInstaller.Outcome.Staged:
                // The path is printed before the hand-off so a player, or a log, can see exactly which bytes will run.
                Console.WriteLine($"update:staged:{result.StagedPath}");
                Console.WriteLine($"update:version:{result.Version}");
                UpdateInstaller.HandOff(result.StagedPath!);
                Console.WriteLine("update:installing");
                return 0;
            case UpdateInstaller.Outcome.NotNewer:
                Console.Error.WriteLine("update:not_newer");
                return 1;
            case UpdateInstaller.Outcome.DigestMismatch:
                // The one refusal worth naming precisely: the bytes are not the ones the manifest promised.
                Console.Error.WriteLine($"update:installer_digest_mismatch:{result.Reason}");
                return 1;
            case UpdateInstaller.Outcome.DownloadFailed:
                Console.Error.WriteLine($"update:download_failed:{result.Reason}");
                return 1;
            case UpdateInstaller.Outcome.StagingFailed:
                Console.Error.WriteLine($"update:staging_failed:{result.Reason}");
                return 1;
            default:
                Console.Error.WriteLine($"update:manifest_unusable:{result.Reason}");
                return 1;
        }
    }

    /// <summary>
    /// Runs a subcommand and turns any unclassified failure into one code.
    ///
    /// The launch path already does this for the same reason: a stack trace can carry installed paths onto the channel a
    /// caller reads, and a caller parsing a refusal needs one token, not a transcript.
    /// </summary>
    private static int Bounded(string code, Func<int> action)
    {
        try
        {
            return action();
        }
        catch (RootRegistrationUnavailableException)
        {
            // The machine has no installation registered. That is a fact the caller can act on, not an unexplained failure.
            Console.Error.WriteLine(RootUnavailable);
            return 1;
        }
        catch (Exception)
        {
            Console.Error.WriteLine(code);
            return 1;
        }
    }

    /// <summary>
    /// The installed program root, read from the registration - the one fact a read-only subcommand needs.
    ///
    /// Deliberately not `CurrentUserRootLayout.DeriveForCurrentUser()`: that also requires the three mutable roots, which the
    /// production entry provisions before deriving. Asking for them here would refuse an update check for a reason that has
    /// nothing to do with whether a release is newer. The path is still validated where it is used.
    /// </summary>
    private static string InstalledProgramRoot() =>
        CurrentUserRootRegistration.ReadForCurrentUser().ProgramRoot;

    /// <summary>
    /// Reports whether a newer release exists, without downloading or running anything.
    ///
    /// One machine-readable line on stdout for a positive answer, one bounded code on stderr for a refusal - the same contract
    /// as `--rollback`, so a caller does not need two parsers.
    /// </summary>
    private static int CheckUpdate(string source)
    {
        var programRoot = InstalledProgramRoot();
        var result = UpdateCheck.CheckAsync(programRoot, source, CancellationToken.None).GetAwaiter().GetResult();
        switch (result.Verdict)
        {
            case UpdateCheck.Verdict.Available:
                Console.WriteLine($"update:available:{result.AvailableVersion}");
                Console.WriteLine($"update:download:{result.DownloadUrl}");
                return 0;
            case UpdateCheck.Verdict.UpToDate:
                Console.WriteLine($"update:up_to_date:{result.InstalledVersion}");
                return 0;
            case UpdateCheck.Verdict.InstalledVersionUnknown:
                Console.Error.WriteLine("update:installed_version_unknown");
                return 1;
            case UpdateCheck.Verdict.ManifestUnusable:
                Console.Error.WriteLine($"update:manifest_unusable:{result.Reason}");
                return 1;
            default:
                Console.Error.WriteLine($"update:source_unavailable:{result.Reason}");
                return 1;
        }
    }

    /// <summary>
    /// Steps back one installed generation and reports what happened, without starting anything.
    ///
    /// Recovery has to be available on a machine where the current release does not start - which is exactly when the
    /// tray and the Host cannot be relied on - so this path touches two files and no composition.
    /// </summary>
    private static int RollBack()
    {
        var result = InstalledGenerationRollback.Restore(InstalledProgramRoot());
        if (result == InstalledGenerationRollback.Result.Restored)
        {
            Console.WriteLine("rollback:restored");
            return 0;
        }

        Console.Error.WriteLine($"rollback:{Reason(result)}");
        return 1;
    }

    private static string Reason(InstalledGenerationRollback.Result result) => result switch
    {
        InstalledGenerationRollback.Result.NothingToRollBack => "nothing_to_roll_back",
        InstalledGenerationRollback.Result.TargetUnavailable => "target_unavailable",
        InstalledGenerationRollback.Result.PointerBusy => "pointer_busy",
        _ => "unavailable",
    };

    /// <summary>
    /// The production entry's full result: the bounded failure it names, and the
    /// reason the failing step itself reported when it reported one. The reason is
    /// never a substitute for the named failure - a consumer matching on the primary
    /// code keeps matching - so it is carried beside it and only appended to the
    /// line.
    /// </summary>
    private readonly record struct LaunchOutcome(
        DesktopLaunchResult Result,
        string? Reason,
        string? Diagnostic,
        string? Stage = null,
        string? ChildStderr = null)
    {
        /// <summary>The no-claim value: the admitted session ran to its end unnamed.</summary>
        internal static readonly LaunchOutcome NoClaim = new(DesktopLaunchResult.Unavailable, null, null);

        internal static LaunchOutcome Of(DesktopLaunchResult result) => new(result, null, null);
    }

    /// <summary>
    /// The entry's entire observable result: the exit status, and at most one bounded
    /// outcome-code line on stderr naming how the launch ended. A code is
    /// always accompanied by a non-zero exit status, and the line carries no path,
    /// no secret and no stack. A step that reported its own specific reason appends
    /// it after the primary code (`primary:reason`) so the reason is recoverable
    /// without changing what the primary code already said; a step that captured what
    /// the failing child wrote about the same refusal appends that excerpt last.
    /// </summary>
    internal static string? OutcomeCode(DesktopLaunchResult result) => OutcomeCode(result, reason: null, diagnostic: null);

    private static string? OutcomeCode(LaunchOutcome outcome) => OutcomeCode(outcome.Result, outcome.Reason, outcome.Diagnostic);

    internal static string? OutcomeCode(DesktopLaunchResult result, string? reason) => OutcomeCode(result, reason, diagnostic: null);

    internal static string? OutcomeCode(DesktopLaunchResult result, string? reason, string? diagnostic)
    {
        var primary = PrimaryOutcomeCode(result);
        if (primary is null) return primary;
        var line = IsReportableReason(reason, primary) ? $"{primary}:{reason}" : primary;
        // The child's own diagnostic is appended after both codes so it can never be
        // mistaken for a second machine-readable code: it begins with a label, and the
        // excerpt behind it is already one redacted line.
        return string.IsNullOrEmpty(diagnostic) ? line : $"{line} {diagnostic}";
    }

    private static string? PrimaryOutcomeCode(DesktopLaunchResult result) => result switch
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
        DesktopLaunchResult.PrimaryInstanceUnavailable => "primary_instance_unavailable",
        _ => UnattributedLaunchFailureCode,
    };

    /// <summary>
    /// Whether a step's own reported reason may go onto the line. The default
    /// category is withheld because it names no reason beyond the failure the
    /// primary code already names - reporting it would read as a second, specific
    /// fact. Anything that is not one bounded lowercase code is withheld too, so the
    /// one channel the launcher reads keeps carrying no path, secret or prose.
    /// </summary>
    private static bool IsReportableReason(string? reason, string primary)
    {
        if (string.IsNullOrEmpty(reason)) return false;
        if (StringComparer.Ordinal.Equals(reason, GuardianLaunchUnavailableException.DefaultCategory)) return false;
        if (StringComparer.Ordinal.Equals(reason, primary)) return false;
        if (reason[0] is < 'a' or > 'z') return false;
        foreach (var character in reason)
            if (character is not (>= 'a' and <= 'z') and not (>= '0' and <= '9') and not '_') return false;
        return true;
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

    /// <summary>
    /// Waits for the one thing that ends an admitted session: the exact child exiting, or the
    /// player asking the primary instance to quit. On a quit this flow STOPS rather than reaping
    /// the child here, because the lease's own close is the single path that ends that exact child:
    /// it hands the child its controller EOF, waits for the child's own exit reclamation inside the
    /// deadline the child declared in its acknowledgement, and terminates it only if that wait
    /// expires. The tray has already said "closing", and no part of this entry claims a Chat or Game
    /// close it cannot prove.
    /// </summary>
    private static async Task<bool> WaitForSessionEndAsync(RuntimeSupervisorLease host, CancellationToken quitRequested, CancellationToken cancellationToken)
    {
        var exit = host.WaitForExitAsync(cancellationToken);
        using var quit = new CancellationTokenSource();
        var playerQuit = Task.Delay(Timeout.Infinite, quitRequested);
        using (quitRequested.Register(static state => ((CancellationTokenSource)state!).Cancel(), quit))
        {
            if (await Task.WhenAny(exit, playerQuit).ConfigureAwait(false) == playerQuit) return true;
        }
        return await exit.ConfigureAwait(false);
    }

    /// <summary>
    /// The step whose failure ended a launch. Registration and layout failures
    /// arrive as their own exception types; every other step fails with the
    /// admitted-child launch exception, so the entry records where it was in
    /// order to name them apart.
    /// </summary>
    private enum LaunchStage { GenerationSelection, GenerationAdmission, ChildLaunch, HostSession }

    /// <summary>
    /// The primary instance's answer to a second invocation: the one intent such an invocation may
    /// deliver is the player asking for the presentation again, which is the same act as the tray's
    /// Open and is allowed to repeat. Both intents in the channel's vocabulary land here, because
    /// this product's presentation is the player's own browser: asking to focus it is asking the
    /// shell's association for the entry again, and re-opening an already-running tab is how the
    /// platform answers that.
    /// </summary>
    internal static PrimaryIntentPipe ServePrimaryIntents(DesktopBrowserPresenter presentation, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(presentation);
        return PrimaryIntentPipe.Start(_ => presentation.Open(), cancellationToken);
    }

    private static async Task<LaunchOutcome> RunProductionAsync(CancellationToken cancellationToken)
    {
        var stage = LaunchStage.GenerationSelection;
        try
        {
            // The app-instance authority comes first, before a generation is selected and before
            // any root is resolved: exactly one primary instance may start Host/runtime, and a
            // second invocation may ask it to open the presentation and nothing else. It owns no
            // Chat continuity, Game, guardian or path lock and is not a substitute for one.
            using var appInstance = AppInstanceOwner.Acquire(AppInstanceOwner.InstalledPartition);
            if (!appInstance.IsPrimary)
            {
                // A secondary invocation starts nothing: no generation, no root layout, no child,
                // and it accepts no bootstrap material from anywhere. Its one action is a bounded
                // intent, and a primary that cannot be reached is reported rather than papered over
                // by becoming a second product.
                return await AppInstanceOwner.RequestOpenAsync(cancellationToken).ConfigureAwait(false)
                    ? LaunchOutcome.NoClaim
                    : LaunchOutcome.Of(DesktopLaunchResult.PrimaryInstanceUnavailable);
            }
            // The player's presentation, as this launch owns it. The tray's Open and a second
            // invocation's intent are the same act on the same object, so the launcher creates it
            // here and the Host supervisor binds its entry into it once the child has acknowledged.
            var presentation = new DesktopBrowserPresenter();
            // The other half of the app-instance authority: from this instant this process ANSWERS
            // the channel a second double-click uses, for the rest of its life. It is declared for
            // disposal before the lease, so the listener always stops first - a secondary that
            // reaches the channel therefore always reaches a process that still owns the instance.
            await using var primaryIntents = ServePrimaryIntents(presentation, cancellationToken);
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
            await using var runtimeSupervisor = new RuntimeSupervisor { Presentation = presentation };
            await using var guardianSupervisor = new GuardianSupervisor();

            // A companion switch the player asked for through the Host takes effect HERE,
            // before the identity is established - because establishing it is what materializes
            // the manifest this launch is about. The switch is the launcher's operation, not the
            // Host's: it parks the authority root that is in play, brings the chosen companion's
            // back, and replaces the durable identity record. Every path derived from that
            // identity - her conversations, her Memory, her cabin binding - already partitions per
            // companion, so nothing else has to move.
            //
            // It runs even when no request exists, because finishing or undoing a switch that died
            // between two of its steps is the same operation over the same facts.
            //
            // A refusal is recorded before it can be forgotten: applying the request spends it, so
            // the operational root is the only place the player's choice and the launcher's answer
            // can still be read (`<operationalRoot>\companion-switch-<instant>.json`, which names
            // the code, the companion the switch was about, and the companion who is still in play).
            var switchOutcome = CompanionSwitch.ApplyPending(layout);
            CompanionSwitchVerdictRecord.Write(layout.OperationalRoot, switchOutcome);

            // The operational deployment manifest is the admitted Host child's
            // deployment identity. The manifest must exist before the child does,
            // because the supervisor requires that file and the Host reads it as
            // input, so a writer inside the child cannot produce it: this step
            // establishes the identity exactly once - minting it only when neither
            // the manifest nor the durable record exists, otherwise projecting the
            // durable record - and never overwrites an existing manifest.
            //
            // Which semantic authority mount this launch performs is not decided here. It is the
            // Host's own decision from the records in the runtime root - the authority's
            // publication marker, the durable identity record and the first-run staging marker
            // (host/src/continuity-semantic-provisioning: `decideProductionAuthorityMountMode`).
            // A mount asked for from this side could contradict them: a launcher saying `known`
            // over a first run it never finished would open a root that has to be provisioned,
            // and one saying `fresh` over a complete authority would be asking for the one mount
            // that may discard. The step's answer - whether this launch minted the identity - is
            // its own fact and does not travel past this point.
            DeploymentIdentity.EstablishForCurrentUser(layout);

            // From here the admitted children are launched: Voice first (the Host
            // child is handed its port/token pair), then the Host runtime and the
            // resident Guardian that attaches to its authenticated broker.
            stage = LaunchStage.ChildLaunch;

            // Voice is an optional capability: the coordinator declines (no admitted
            // artifact, consent not accepted, or a preference record it refuses) and the
            // composition stays on pure-text Chat. When it resolves, the same loopback
            // port/token pair goes into both the Voice child and the exact Host child so
            // the Host wire can reach it.
            //
            // A refused preference record is the one decline nobody would ever see: Voice
            // absent looks the same as Voice never consented to, so the code goes where the
            // launcher's other refusals already go (`VoiceLaunchVerdictRecord`).
            var voiceDecision = VoiceLaunchCoordinator.Resolve(
                selection.GenerationRoot,
                selection.Generation,
                selection.InventoryDigest,
                Path.Combine(layout.DataRoot, "settings", "player-preference.json"));
            if (voiceDecision.Refusal is { } voiceRefusal) VoiceLaunchVerdictRecord.Write(layout.OperationalRoot, voiceRefusal);
            var voiceLaunch = voiceDecision.Launch;
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
                        persona: voiceLaunch.Persona,
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
            // The Host child owns the session: the entry is done when that exact
            // child has exited. A wait that could not reap it is a failed session
            // rather than one more silent success.
            //
            // The shell is the player's own presence on their desktop, so the tray exists once
            // the Host is serving: a launch that never reached readiness never opens a tray, and
            // a tray that cannot be created never affects the session. Quit is the only thing it
            // owns here, and it ends this flow - which is what seals ingress and ends the exact
            // admitted child - instead of claiming a per-surface close the launcher cannot prove.
            //
            // It also outlives the quit it started. The close the lease runs can take longer than
            // a tray that vanished at the click would ever explain, so the tray is disposed after
            // the lease has ended the child and not before: while the Host is still reclaiming,
            // the tray is the one surface that can say so (`ShellIntentRouter.ClosingCopy`).
            var host = await runtimeSupervisor.StartHostAsync(selection, runtime, layout, cancellationToken, hostOptions).ConfigureAwait(false);
            TrayShell? tray = null;
            try
            {
                // The accepted acknowledgement is this run's completion fact - the Host has
                // opened its databases, provisioned or opened the semantic authority and is ready
                // for service - so the staging marker's intent is spent here, and the only launch
                // that can be holding an unspent one is one that died before this point. Clearing
                // it unconditionally is the same statement the Host's own mount decision makes: a
                // marker beside a published authority is spent, and a marker over a root that was
                // never published can still only attribute that root to a first run.
                FirstRunStaging.Clear(layout);
                stage = LaunchStage.HostSession;
                // The authenticated Host broker session is the only thing that may
                // ask for a recovery, and the image admitted for this generation is
                // the only image it may launch. Mounting binds those two; it has to
                // happen before the resident Guardian starts the broker's command
                // loop, which is what serves a recovery request.
                host.AttachRecoveryLaunch(new RecoveryLaunchTrigger(image, guardianSupervisor));
                // The broker creates the resident Guardian an attempt needs and settles it when that attempt
                // ends, so the launcher hands over the FACTORY and keeps no lease of its own: a Guardian this
                // entry never created is one it can never have to settle, and the second attempt in this
                // Desktop process is the broker's to give a fresh one.
                await host.AttachResidentGuardianFactory(
                    token => guardianSupervisor.StartResidentAsync(image, token), cancellationToken).ConfigureAwait(false);
                using var quit = new CancellationTokenSource();
                tray = TrayShell.Start(new ShellIntentRouter(
                    () => runtimeSupervisor.Presentation.Open(),
                    () =>
                    {
                        try
                        {
                            quit.Cancel();
                            return true;
                        }
                        catch (ObjectDisposedException)
                        {
                            return false;
                        }
                    },
                    // The Host's own published number: the point at which it has already named a
                    // step as stuck is where this shell stops saying only that it is closing.
                    host.Result.StepHangDeadlineMs));
                if (!await WaitForSessionEndAsync(host, quit.Token, cancellationToken).ConfigureAwait(false))
                    return LaunchOutcome.Of(DesktopLaunchResult.HostSessionFailed);
                return LaunchOutcome.NoClaim;
            }
            finally
            {
                // The lease ends the exact child (controller EOF, then the wait inside the deadline
                // the child published, then the watchdog); the shell goes last, because it is what
                // narrates that wait.
                try { await host.DisposeAsync().ConfigureAwait(false); }
                finally { tray?.Dispose(); }
            }
        }
        catch (GuardianLaunchUnavailableException exception)
        {
            var named = stage switch
            {
                LaunchStage.GenerationSelection => DesktopLaunchResult.HostGenerationUnavailable,
                LaunchStage.GenerationAdmission => DesktopLaunchResult.GenerationAdmissionRefused,
                LaunchStage.ChildLaunch => DesktopLaunchResult.GuardianLaunchUnavailable,
                _ => DesktopLaunchResult.HostSessionFailed,
            };
            // The launch stage names where the launch was; the exception's own
            // category names which blocker refused there, and the diagnostic carries
            // what the refused child itself wrote about it. All three survive, and the two
            // structured facts ride beside them so the player's window and the record can name the
            // step and the child's own code without re-parsing the operator's one line.
            return new LaunchOutcome(named, exception.Category, exception.Diagnostic, exception.BootstrapStage, exception.ChildStderr);
        }
        catch (RootRegistrationUnavailableException) { return LaunchOutcome.Of(DesktopLaunchResult.RootRegistrationUnavailable); }
        catch (RootLayoutUnavailableException) { return LaunchOutcome.Of(DesktopLaunchResult.RootLayoutUnavailable); }
        catch (MutableRootsUnavailableException) { return LaunchOutcome.Of(DesktopLaunchResult.MutableRootsUnavailable); }
        catch (DeploymentIdentityUnavailableException) { return LaunchOutcome.Of(DesktopLaunchResult.DeploymentIdentityUnavailable); }
        catch (DeploymentIdentityMintUnavailableException) { return LaunchOutcome.Of(DesktopLaunchResult.DeploymentIdentityMintUnavailable); }
        catch (DeploymentIdentityEstablishUnavailableException) { return LaunchOutcome.Of(DesktopLaunchResult.DeploymentIdentityEstablishUnavailable); }
        catch (DeploymentIdentityConflictException) { return LaunchOutcome.Of(DesktopLaunchResult.DeploymentIdentityConflict); }
    }
}
