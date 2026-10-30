namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The launcher's own runtime story, asserted against the project that produces it.
///
/// The defect this closes is the first thing a player without the SDK ever saw: a
/// framework-dependent launcher starts with the platform's "you need .NET 8.0 Desktop
/// Runtime" dialog, before a single line of the product runs. Nothing about the launcher
/// needs the machine's shared runtime, so a Release build carries its own - and this test
/// reads the build's own properties, so a release configuration that silently reverts to
/// framework-dependent publishing fails here instead of on a player's machine.
/// </summary>
public sealed class LauncherSelfContainedTests
{
    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (Directory.Exists(Path.Combine(directory.FullName, "desktop")) &&
                File.Exists(Path.Combine(directory.FullName, "package.json")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("repository root not found");
    }

    private static string LauncherProjectPath() =>
        Path.Combine(RepositoryRoot(), "desktop", "GameBuddy.Desktop", "GameBuddy.Desktop.csproj");

    [Fact]
    public void The_release_launcher_publishes_self_contained_for_one_runtime_identifier()
    {
        var project = File.ReadAllText(LauncherProjectPath());
        // The condition is the whole point: a Release build is what a player receives, so the
        // properties must apply to it - and only to it, so the developer loop and the test
        // project keep building against the SDK that is already installed.
        Assert.Contains("'$(Configuration)' == 'Release'", project, StringComparison.Ordinal);
        Assert.Contains("<SelfContained>true</SelfContained>", project, StringComparison.Ordinal);
        Assert.Contains("<RuntimeIdentifier>win-x64</RuntimeIdentifier>", project, StringComparison.Ordinal);
        Assert.Contains("<PublishSingleFile>true</PublishSingleFile>", project, StringComparison.Ordinal);
        // Native libraries have to live inside the single file too. With extraction disabled the
        // publish left six native DLLs beside the exe, which is not the one download a player
        // double-clicks.
        Assert.Contains("<IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>", project, StringComparison.Ordinal);
    }

    [Fact]
    public void The_release_installer_is_self_contained_so_a_clean_machine_can_run_it()
    {
        // The defect this closes, found by actually trying to install on a machine without the
        // SDK: the launcher was made self-contained and the INSTALLER that launches it was not,
        // so double-clicking Setup.exe raised "you need .NET 8.0 Desktop Runtime" before a single
        // line of the product ran - on the machine that has no product yet to fall back on.
        //
        // The uninstaller is a copy of this same executable (Program.InstallUninstaller), so one
        // decision covers both.
        var project = File.ReadAllText(
            Path.Combine(RepositoryRoot(), "desktop", "installer", "GameBuddy.Setup", "GameBuddy.Setup.csproj"));
        Assert.Contains("'$(Configuration)' == 'Release'", project, StringComparison.Ordinal);
        Assert.Contains("<SelfContained>true</SelfContained>", project, StringComparison.Ordinal);
        Assert.Contains("<RuntimeIdentifier>win-x64</RuntimeIdentifier>", project, StringComparison.Ordinal);
        Assert.Contains("<PublishSingleFile>true</PublishSingleFile>", project, StringComparison.Ordinal);
    }

    [Fact]
    public void The_installer_copies_the_uninstaller_from_every_shape_the_build_can_produce()
    {
        // The uninstaller is a copy of this executable set. A self-contained single-file Release
        // emits ONE file; a framework-dependent build emits the apphost plus assembly and
        // configuration. Both shapes are legal, so the copy must require the executable and copy
        // whichever companions exist - requiring the whole set would make a correct Release fail
        // its own install, and copying only the executable would ship an uninstaller that cannot
        // start on the framework-dependent builds the tests use.
        var program = File.ReadAllText(
            Path.Combine(RepositoryRoot(), "desktop", "installer", "GameBuddy.Setup", "Program.cs"));
        Assert.Contains("File.Exists(sourceFile)", program, StringComparison.Ordinal);
        Assert.Contains("continue;", program, StringComparison.Ordinal);
    }
}
