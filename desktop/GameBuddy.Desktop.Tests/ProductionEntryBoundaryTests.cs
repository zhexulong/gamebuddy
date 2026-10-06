namespace GameBuddy.Desktop.Tests;

public sealed class ProductionEntryBoundaryTests
{
    [Fact]
    public void ProductionEntry_reaches_only_current_user_registration_and_has_no_fixture_graph_edge()
    {
        var source = File.ReadAllText(DesktopProgramSource());

        var productionPath = source[source.IndexOf("private static async Task<DesktopLaunchResult> RunProductionAsync", StringComparison.Ordinal)..];
        Assert.Contains("CurrentUserRootLayout.DeriveForCurrentUser()", productionPath, StringComparison.Ordinal);
        Assert.Contains("InstalledGenerationSelection.Acquire(layout.ProgramRoot)", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("DeriveForTesting", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("Fixtures", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("ICurrentUserRegistrationStore", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("ICurrentUserRootRegistrationReader", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("ILocalApplicationDataProvider", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("--root", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("GAMEBUDDY_ROOT", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("SetValue", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateSubKey", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("DeleteSubKey", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("Process.", productionPath, StringComparison.Ordinal);
    }

    [Fact]
    public void Host_only_testing_entry_bootstraps_host_without_admitting_or_attaching_a_guardian()
    {
        var source = File.ReadAllText(DesktopProgramSource());
        var hostEntry = source[source.IndexOf("internal static async Task<DesktopLaunchResult> RunHostForTestingAsync", StringComparison.Ordinal)..source.IndexOf("private static async Task<DesktopLaunchResult> RunProductionAsync", StringComparison.Ordinal)];

        Assert.Contains("supervisor.StartHostAsync(selection, runtime, layout, cancellationToken)", hostEntry, StringComparison.Ordinal);
        Assert.DoesNotContain("InstalledGenerationAdmission", hostEntry, StringComparison.Ordinal);
        Assert.DoesNotContain("AdmitGuardianAsync", hostEntry, StringComparison.Ordinal);
        Assert.DoesNotContain("GuardianSupervisor", hostEntry, StringComparison.Ordinal);
        Assert.DoesNotContain("StartRecoveryAsync", hostEntry, StringComparison.Ordinal);
        Assert.DoesNotContain("AttachResidentGuardianAsync", hostEntry, StringComparison.Ordinal);
    }

    [Fact]
    public void Production_entry_admits_the_matching_guardian_then_attaches_it_only_after_host_bootstrap()
    {
        var source = File.ReadAllText(DesktopProgramSource());
        var productionPath = source[source.IndexOf("private static async Task<DesktopLaunchResult> RunProductionAsync", StringComparison.Ordinal)..];

        var admit = productionPath.IndexOf("AdmitGuardianAsync(selection, cancellationToken)", StringComparison.Ordinal);
        var host = productionPath.IndexOf("runtimeSupervisor.StartHostAsync(selection, runtime, layout, cancellationToken, hostOptions)", StringComparison.Ordinal);
        var resident = productionPath.IndexOf("guardianSupervisor.StartResidentAsync(image, cancellationToken)", StringComparison.Ordinal);
        var attach = productionPath.IndexOf("host.AttachResidentGuardianAsync(resident, cancellationToken)", StringComparison.Ordinal);
        Assert.True(admit >= 0 && host > admit && resident > host && attach > resident);
        Assert.Contains("await host.WaitForExitAsync(cancellationToken)", productionPath, StringComparison.Ordinal);
        Assert.Contains("if (resident is not null) await resident.DisposeAsync()", productionPath, StringComparison.Ordinal);
        Assert.Contains("return DesktopLaunchResult.Unavailable;", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("StartRecoveryAsync", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("GuardianStarted", productionPath, StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionAssembly_does_not_reference_the_fixture_test_assembly()
    {
        Assert.DoesNotContain(
            typeof(Program).Assembly.GetReferencedAssemblies(),
            assembly => StringComparer.Ordinal.Equals(assembly.Name, typeof(ProductionEntryBoundaryTests).Assembly.GetName().Name));
    }

    [Fact]
    public void ProductionRegistration_owns_the_only_windows_registry_and_known_folder_implementations()
    {
        var source = File.ReadAllText(DesktopRegistrationSource());
        var layoutSource = File.ReadAllText(DesktopLayoutSource());

        Assert.Contains("private sealed class WindowsCurrentUserRegistrationStore", source, StringComparison.Ordinal);
        Assert.Contains("private sealed class WindowsLocalApplicationDataProvider", layoutSource, StringComparison.Ordinal);
        Assert.DoesNotContain("GameBuddy.Desktop.Tests", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Fixtures", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Production_has_no_registration_writer_only_Setup_and_the_uninstaller_write_it()
    {
        // The boundary this test protects was already "the production entry never
        // creates or removes the registration". With the writer gone from the
        // launcher entirely, the same boundary is asserted directly: the
        // registration store is read-only and no production file can write the
        // current-user registry at all.
        var source = File.ReadAllText(DesktopRegistrationSource());

        Assert.DoesNotContain("SetValue", source, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateSubKey", source, StringComparison.Ordinal);
        Assert.DoesNotContain("DeleteSubKey", source, StringComparison.Ordinal);
        Assert.Contains("IReadOnlyDictionary<string, CurrentUserRegistrationValue>? ReadValues();", source, StringComparison.Ordinal);
        Assert.DoesNotContain("void SetString", source, StringComparison.Ordinal);

        foreach (var file in Directory.EnumerateFiles(Path.GetDirectoryName(DesktopRegistrationSource())!, "*.cs"))
        {
            var text = File.ReadAllText(file);
            Assert.DoesNotContain("Registry.CurrentUser.CreateSubKey", text, StringComparison.Ordinal);
            Assert.DoesNotContain("Registry.CurrentUser.DeleteSubKey", text, StringComparison.Ordinal);
            Assert.DoesNotContain("Registry.CurrentUser.SetValue", text, StringComparison.Ordinal);
        }
    }

    private static string DesktopProgramSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "Program.cs"));

    private static string DesktopRegistrationSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "CurrentUserRootRegistration.cs"));

    private static string DesktopLayoutSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "CurrentUserRootLayout.cs"));
}
