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
        Assert.DoesNotContain("CreateForCurrentUser", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("RemoveForCurrentUserAfterCallerPolicy", productionPath, StringComparison.Ordinal);
        Assert.DoesNotContain("Process.", productionPath, StringComparison.Ordinal);
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

        Assert.Contains("private sealed class WindowsCurrentUserRegistrationStore", source, StringComparison.Ordinal);
        Assert.Contains("private sealed class WindowsLocalApplicationDataProvider", source, StringComparison.Ordinal);
        Assert.DoesNotContain("GameBuddy.Desktop.Tests", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Fixtures", source, StringComparison.Ordinal);
    }

    private static string DesktopProgramSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "Program.cs"));

    private static string DesktopRegistrationSource() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "CurrentUserRootRegistration.cs"));
}
