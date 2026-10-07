namespace GameBuddy.Desktop.Tests;

/// <summary>
/// Guards the launcher's provisioning wiring in the production entry: the mutable
/// roots are provisioned before anything is read or launched, the deployment
/// identity is required after the generation is admitted and before any child is
/// launched, and each new failure names itself with its own bounded code.
///
/// The ordering is text-asserted for the same reason the recovery-launch wiring is:
/// the production entry resolves the real current-user registration and launches
/// real children, so what a focused test can prove is that every step exists in the
/// required position and that the outcome vocabulary stays honest.
/// </summary>
public sealed class LauncherProvisioningWiringTests
{
    [Fact]
    public void Production_entry_provisions_the_mutable_roots_before_it_derives_the_layout()
    {
        var productionPath = ProductionEntry();

        var provision = productionPath.IndexOf("CurrentUserRootLayout.ProvisionMutableRootsForCurrentUser()", StringComparison.Ordinal);
        var derive = productionPath.IndexOf("CurrentUserRootLayout.DeriveForCurrentUser()", StringComparison.Ordinal);

        // Provisioning exists precisely because the first derivation fails without it,
        // so it must come first.
        Assert.True(provision >= 0 && derive > provision, $"expected provision < derive, got provision={provision} derive={derive}");
    }

    [Fact]
    public void Production_entry_requires_the_deployment_identity_after_admission_and_before_any_child_launch()
    {
        var productionPath = ProductionEntry();

        var admit = productionPath.IndexOf("AdmitGuardianAsync(selection, cancellationToken)", StringComparison.Ordinal);
        var identity = productionPath.IndexOf("DeploymentIdentity.EstablishForCurrentUser(layout)", StringComparison.Ordinal);
        var host = productionPath.IndexOf("runtimeSupervisor.StartHostAsync(selection, runtime, layout, cancellationToken, hostOptions)", StringComparison.Ordinal);

        Assert.True(admit >= 0 && identity > admit, $"expected admit < identity, got admit={admit} identity={identity}");
        Assert.True(host > identity, $"expected identity < host, got identity={identity} host={host}");
    }

    [Fact]
    public void Production_entry_chooses_fresh_only_on_the_run_that_established_the_identity()
    {
        var productionPath = ProductionEntry();

        // The identity step reports whether this run minted the identity, and only
        // that run may ask the Host to create a semantic authority: a later launch
        // presenting the same identity must open the existing one as known.
        var established = productionPath.IndexOf("DeploymentIdentity.EstablishForCurrentUser(layout)", StringComparison.Ordinal);
        var mode = productionPath.IndexOf("GameSessionMode = mintedDeploymentIdentity", StringComparison.Ordinal);
        Assert.True(established >= 0 && mode > established, $"expected establish < mode, got establish={established} mode={mode}");
        Assert.Contains("HostBootstrapEnvironmentOptions.FreshGameSessionMode", productionPath, StringComparison.Ordinal);
        Assert.Contains("HostBootstrapEnvironmentOptions.KnownGameSessionMode", productionPath, StringComparison.Ordinal);
    }

    [Fact]
    public void Production_entry_writes_no_file_itself_and_names_no_manifest_path()
    {
        var productionPath = ProductionEntry();

        // Establishing the identity is the launcher's step, but the entry is not the
        // writer: no identity, path or file format is spelled out here, so the entry
        // cannot grow a second write path or a hand-written manifest.
        Assert.Contains("DeploymentIdentity.EstablishForCurrentUser(layout)", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("deployment-manifest.json", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("deployment-identity.json", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("WriteAllText", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("WriteAllBytes", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("File.Create", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("FileStream", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("StreamWriter", productionPath, StringComparison.Ordinal);
        // No switch can force a mint or a re-mint: the entry takes no arguments at all.
        Assert.DoesNotContain("string[] args", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment.GetEnvironmentVariable", productionPath, StringComparison.Ordinal);
    }

    [Fact]
    public void Production_entry_reports_the_failing_step_own_reason_instead_of_discarding_it()
    {
        var productionPath = ProductionEntry();

        // The launch stage's catch must bind the exception and carry its category
        // out with the named failure: catching it unnamed is exactly how the reason
        // was lost before. (The Voice catch inside this path stays unnamed on
        // purpose - a Voice child that cannot start is not a launch failure at all.)
        Assert.Contains("catch (GuardianLaunchUnavailableException exception)", productionPath, StringComparison.Ordinal);
        Assert.Contains("return new LaunchOutcome(named, exception.Category, exception.Diagnostic);", productionPath, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(productionPath, "exception.Category"));
        Assert.Equal(1, CountOccurrences(productionPath, "exception.Diagnostic"));
    }

    [Fact]
    public void A_launch_step_that_reported_its_own_reason_reports_that_reason_beside_the_primary_code()
    {
        // The reason is the failing step's own category, appended rather than
        // substituted, so the blocker is named without the launch stage's code
        // changing shape for consumers that match on it.
        Assert.Equal(
            "guardian_launch_unavailable:host_runtime_unavailable",
            Program.OutcomeCode(DesktopLaunchResult.GuardianLaunchUnavailable, "host_runtime_unavailable"));
        Assert.Equal(
            "guardian_launch_unavailable:voice_launch_unavailable",
            Program.OutcomeCode(DesktopLaunchResult.GuardianLaunchUnavailable, "voice_launch_unavailable"));
        Assert.Equal(
            "host_generation_unavailable:host_runtime_unavailable",
            Program.OutcomeCode(DesktopLaunchResult.HostGenerationUnavailable, "host_runtime_unavailable"));
    }

    [Fact]
    public void The_default_category_is_withheld_so_the_line_never_states_a_reason_it_does_not_have()
    {
        // `guardian_launch_unavailable` is both a primary code and the default
        // category, but the two mean different things: as a primary code it names
        // the launch stage, and as a default category it names no reason at all.
        // Reporting it for the stage would read as a specific second fact.
        Assert.Equal(
            "generation_admission_refused",
            Program.OutcomeCode(DesktopLaunchResult.GenerationAdmissionRefused, GuardianLaunchUnavailableException.DefaultCategory));
        Assert.Equal(
            "generation_admission_refused",
            Program.OutcomeCode(DesktopLaunchResult.GenerationAdmissionRefused, reason: null));
        Assert.Equal(
            "generation_admission_refused",
            Program.OutcomeCode(DesktopLaunchResult.GenerationAdmissionRefused, reason: ""));
        // Nothing else may reach the launcher's one channel either: no path, no
        // prose, no mixed case, no punctuation.
        Assert.Equal("generation_admission_refused", Program.OutcomeCode(DesktopLaunchResult.GenerationAdmissionRefused, "C:\\Users\\someone\\AppData\\Local"));
        Assert.Equal("generation_admission_refused", Program.OutcomeCode(DesktopLaunchResult.GenerationAdmissionRefused, "Guardian launch unavailable"));
        Assert.Equal("generation_admission_refused", Program.OutcomeCode(DesktopLaunchResult.GenerationAdmissionRefused, "Host_Runtime_Unavailable"));
    }

    [Fact]
    public void The_primary_code_is_unchanged_for_consumers_that_match_on_it()
    {
        // Every failure member still reports exactly its own code when no reason is
        // carried: the appended reason is additive, never a replacement.
        foreach (var result in Enum.GetValues<DesktopLaunchResult>())
        {
            var withoutReason = Program.OutcomeCode(result);
            Assert.Equal(withoutReason, Program.OutcomeCode(result, reason: null));
            if (withoutReason is null) continue;
            Assert.StartsWith(withoutReason + ":", Program.OutcomeCode(result, "host_runtime_unavailable"), StringComparison.Ordinal);
            Assert.Equal(withoutReason, withoutReason.Split(':')[0]);
        }

        Assert.Equal("guardian_launch_unavailable", Program.OutcomeCode(DesktopLaunchResult.GuardianLaunchUnavailable));
        Assert.Equal("host_session_failed", Program.OutcomeCode(DesktopLaunchResult.HostSessionFailed));
    }

    [Fact]
    public void Every_named_launch_failure_has_its_own_bounded_outcome_code()
    {
        // The no-claim value stays the only silent one.
        Assert.Null(Program.OutcomeCode(DesktopLaunchResult.Unavailable));

        // The three results only the testing entrypoints produce are not failures: they
        // deliberately fall through to the unattributed code, so they are out of scope
        // for the production failure vocabulary this test pins.
        var nonFailure = new[]
        {
            DesktopLaunchResult.RegistrationReady,
            DesktopLaunchResult.HostStarted,
            DesktopLaunchResult.GuardianStarted,
        };

        var claimed = new Dictionary<string, DesktopLaunchResult>(StringComparer.Ordinal);
        foreach (var result in Enum.GetValues<DesktopLaunchResult>())
        {
            if (result == DesktopLaunchResult.Unavailable || nonFailure.Contains(result)) continue;
            var code = Program.OutcomeCode(result);
            Assert.False(string.IsNullOrEmpty(code), $"{result} has no outcome code");
            Assert.Matches("^[a-z][a-z0-9_]*$", code!);
            Assert.True(claimed.TryAdd(code!, result), $"outcome code '{code}' is shared by {claimed[code!]} and {result}");
        }

        // Every failure member is named, and no two share a code.
        Assert.Equal(11, claimed.Count);

        // The codes this lane added, named for the event rather than borrowed.
        Assert.Equal("mutable_roots_unavailable", Program.OutcomeCode(DesktopLaunchResult.MutableRootsUnavailable));
        Assert.Equal("deployment_identity_unavailable", Program.OutcomeCode(DesktopLaunchResult.DeploymentIdentityUnavailable));
        Assert.Equal("deployment_identity_mint_unavailable", Program.OutcomeCode(DesktopLaunchResult.DeploymentIdentityMintUnavailable));
        Assert.Equal("deployment_identity_establish_unavailable", Program.OutcomeCode(DesktopLaunchResult.DeploymentIdentityEstablishUnavailable));
        Assert.Equal("deployment_identity_conflict", Program.OutcomeCode(DesktopLaunchResult.DeploymentIdentityConflict));
        Assert.True(claimed.ContainsKey("root_layout_unavailable"));
        Assert.True(claimed.ContainsKey("guardian_launch_unavailable"));
    }

    [Fact]
    public void The_provisioning_step_never_writes_files()
    {
        foreach (var file in new[] { "CurrentUserRootLayout.cs", "OperationalDeploymentManifest.cs" })
        {
            var source = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", file)));
            Assert.DoesNotContain("WriteAllText", source, StringComparison.Ordinal);
            Assert.DoesNotContain("WriteAllBytes", source, StringComparison.Ordinal);
            Assert.DoesNotContain("WriteAllLines", source, StringComparison.Ordinal);
            Assert.DoesNotContain("File.Create", source, StringComparison.Ordinal);
            Assert.DoesNotContain("FileStream", source, StringComparison.Ordinal);
            Assert.DoesNotContain("StreamWriter", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Registry", source, StringComparison.Ordinal);
        }

        // The only filesystem effect of provisioning is creating directories.
        var layoutSource = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "CurrentUserRootLayout.cs")));
        Assert.Contains("Directory.CreateDirectory(path);", layoutSource, StringComparison.Ordinal);
        Assert.Contains("createMissing: true", layoutSource, StringComparison.Ordinal);
    }

    [Fact]
    public void The_identity_owner_is_the_one_place_the_launcher_writes_an_identity()
    {
        var identitySource = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "DeploymentIdentity.cs")));

        // One ordinary create per file, and never an adoption of something that is
        // already there: a re-mint must fail rather than silently replace an identity.
        Assert.Contains("FileMode.CreateNew", identitySource, StringComparison.Ordinal);
        Assert.DoesNotContain("FileMode.Create,", identitySource, StringComparison.Ordinal);
        Assert.DoesNotContain("FileMode.OpenOrCreate", identitySource, StringComparison.Ordinal);
        Assert.DoesNotContain("Replace(", identitySource, StringComparison.Ordinal);
        // No identity value comes from the environment, an override or a default
        // principal, and the forbidden fallback name appears nowhere.
        Assert.DoesNotContain("Environment.GetEnvironmentVariable", identitySource, StringComparison.Ordinal);
        Assert.DoesNotContain("local_default", identitySource, StringComparison.Ordinal);
        Assert.DoesNotContain("Registry", identitySource, StringComparison.Ordinal);
        // The launcher may not write a generation-derived identity either.
        Assert.DoesNotContain("selection.", identitySource, StringComparison.Ordinal);
    }

    private static int CountOccurrences(string source, string value)
    {
        var count = 0;
        for (var index = source.IndexOf(value, StringComparison.Ordinal); index >= 0; index = source.IndexOf(value, index + value.Length, StringComparison.Ordinal)) count++;
        return count;
    }

    private static string ProductionEntry()
    {
        var source = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "Program.cs")));
        return source[source.IndexOf("private static async Task<LaunchOutcome> RunProductionAsync", StringComparison.Ordinal)..];
    }
}
