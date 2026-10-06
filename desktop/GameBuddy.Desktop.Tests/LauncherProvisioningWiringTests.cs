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
        var identity = productionPath.IndexOf("OperationalDeploymentManifest.Require(layout)", StringComparison.Ordinal);
        var host = productionPath.IndexOf("runtimeSupervisor.StartHostAsync(selection, runtime, layout, cancellationToken, hostOptions)", StringComparison.Ordinal);

        Assert.True(admit >= 0 && identity > admit, $"expected admit < identity, got admit={admit} identity={identity}");
        Assert.True(host > identity, $"expected identity < host, got identity={identity} host={host}");
    }

    [Fact]
    public void Production_entry_never_writes_or_mints_a_deployment_manifest()
    {
        var productionPath = ProductionEntry();

        // The identity is not the launcher's to create: minting it here would make the
        // launcher the semantic-identity authority, which bootstrap does not own.
        Assert.DoesNotContain("deployment-manifest.json", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("WriteAllText", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("File.Create", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("StreamWriter", productionPath, StringComparison.Ordinal);
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
        Assert.Equal(8, claimed.Count);

        // The two codes this lane added, named for the event rather than borrowed.
        Assert.Equal("mutable_roots_unavailable", Program.OutcomeCode(DesktopLaunchResult.MutableRootsUnavailable));
        Assert.Equal("deployment_identity_unavailable", Program.OutcomeCode(DesktopLaunchResult.DeploymentIdentityUnavailable));
        Assert.True(claimed.ContainsKey("root_layout_unavailable"));
        Assert.True(claimed.ContainsKey("guardian_launch_unavailable"));
    }

    [Fact]
    public void The_provisioning_and_identity_steps_never_write_files()
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

    private static string ProductionEntry()
    {
        var source = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "Program.cs")));
        return source[source.IndexOf("private static async Task<DesktopLaunchResult> RunProductionAsync", StringComparison.Ordinal)..];
    }
}
