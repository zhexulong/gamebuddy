using Microsoft.Win32;

namespace GameBuddy.Setup;

/// <summary>
/// The installed layout the installer owns. It is the exact mirror of the
/// launcher's read side (<c>GameBuddy.Desktop/CurrentUserRootRegistration.cs</c>
/// and <c>CurrentUserRootLayout.cs</c>): the program root is registered, the three
/// mutable roots are derived from the current user's LocalApplicationData and are
/// never stored anywhere.
/// </summary>
internal sealed class SetupLayout
{
    internal const string MarkerSubKey = @"Software\GameBuddy\Registration\v1";
    internal const string MarkerSchemaValueName = "schema";
    internal const string MarkerProgramRootValueName = "programRoot";
    internal const string RegistrationSchemaVersion = "gamebuddy-windows-root-registration/v1";
    internal const string UninstallSubKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\GameBuddy";
    internal const string ProductDisplayName = "GameBuddy";
    internal const string ProductPublisher = "GameBuddy";
    internal const string UninstallerRelativePath = @"uninstall\GameBuddy.Setup.exe";
    internal const string PointerFileName = "current.json";
    internal const string PointerSchema = "gamebuddy-host-production-current/v2";
    internal const string GenerationsDirectoryName = "generations";
    // The entry the player double-clicks. `host/scripts/package-player-distribution.mjs`
    // lays it at the payload root, so it is at the program root once extracted.
    internal const string LauncherEntryRelativePath = "GameBuddy.Desktop.exe";

    private SetupLayout(string localApplicationData)
    {
        LocalApplicationData = localApplicationData;
        ProgramRoot = Path.Combine(localApplicationData, "Programs", "GameBuddy");
        DataRoot = Path.Combine(localApplicationData, "GameBuddy", "data");
        OperationalRoot = Path.Combine(localApplicationData, "GameBuddy", "operational");
        PresentationRoot = Path.Combine(localApplicationData, "GameBuddy", "presentation");
    }

    internal string LocalApplicationData { get; }
    internal string ProgramRoot { get; }
    internal string DataRoot { get; }
    internal string OperationalRoot { get; }
    internal string PresentationRoot { get; }
    internal string UninstallerPath => Path.Combine(ProgramRoot, UninstallerRelativePath);

    /// <summary>
    /// The fixed per-user layout for the current user. <paramref name="localApplicationDataOverride"/>
    /// exists so the installer can be exercised end to end against a scratch root
    /// without writing the machine's real product locations; production passes none.
    /// </summary>
    internal static SetupLayout Resolve(string? localApplicationDataOverride)
    {
        var local = string.IsNullOrWhiteSpace(localApplicationDataOverride)
            ? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            : localApplicationDataOverride;
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
        {
            throw new SetupException(SetupFailure.ProgramRootUnavailable);
        }

        return new SetupLayout(Path.TrimEndingDirectorySeparator(Path.GetFullPath(local)));
    }

    internal static bool IsRunningFrom(string directory)
    {
        try
        {
            var candidate = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
            // The executable's OWN path decides this, not `AppContext.BaseDirectory`.
            //
            // Measured: for a self-contained single-file image, BaseDirectory is the managed
            // entry assembly's base - which is the host's own location in some runtimes and an
            // extraction cache in others, but is not a reliable answer to "which folder does this
            // .exe live in". The uninstaller used that answer to choose its removal strategy, got
            // `false` while it was in fact running from inside the program root, and then tried a
            // synchronous delete of the directory holding its own locked image - which cannot
            // succeed and reported `installer_ok` anyway. `Environment.ProcessPath` is the path of
            // the image actually executing, so it answers the question that matters.
            var runningImage = Environment.ProcessPath;
            if (!string.IsNullOrEmpty(runningImage))
            {
                var imageDirectory = Path.GetDirectoryName(Path.GetFullPath(runningImage));
                if (imageDirectory is not null)
                {
                    var imageFolder = Path.TrimEndingDirectorySeparator(Path.GetFullPath(imageDirectory));
                    if (StringComparer.OrdinalIgnoreCase.Equals(imageFolder, candidate) ||
                        imageFolder.StartsWith(candidate + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }

            var baseDirectory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(AppContext.BaseDirectory));
            return StringComparer.OrdinalIgnoreCase.Equals(baseDirectory, candidate) ||
                baseDirectory.StartsWith(candidate + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }
    }

    /// <summary>
    /// Writes the two paths the branch decision is made from, next to the user registry marker.
    /// A branch this installer chose wrongly is otherwise invisible: both branches print the same
    /// success code, and the difference between "the removal ran" and "the removal was never
    /// scheduled" is the whole defect. The paths are the product's own fixed layout, so nothing
    /// here is a secret.
    /// </summary>
    internal void WriteBranchDiagnostics()
    {
        try
        {
            var directory = Path.Combine(LocalApplicationData, "GameBuddy");
            Directory.CreateDirectory(directory);
            File.WriteAllLines(
                Path.Combine(directory, "uninstall-branch.txt"),
                [
                    $"processPath={Environment.ProcessPath}",
                    $"baseDirectory={AppContext.BaseDirectory}",
                    $"programRoot={ProgramRoot}",
                    $"runningFromProgramRoot={IsRunningFrom(ProgramRoot)}",
                ]);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Diagnostics never change the operation's outcome.
        }
    }

    internal void EnsureOrdinaryAncestors(string target)
    {
        var relative = Path.GetRelativePath(LocalApplicationData, target);
        if (Path.IsPathFullyQualified(relative) || relative == ".." || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new SetupException(SetupFailure.ProgramRootUnavailable);
        }

        var current = LocalApplicationData;
        Directory.CreateDirectory(current);
        foreach (var segment in relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (string.IsNullOrEmpty(segment))
            {
                continue;
            }

            current = Path.Combine(current, segment);
            if (Directory.Exists(current) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
            {
                // The launcher refuses a reparse boundary anywhere on a root path;
                // the installer must not create one either.
                throw new SetupException(SetupFailure.ProgramRootUnavailable);
            }
        }
    }
}

/// <summary>
/// The two registration items, and the only writer of them. The launcher has no
/// writer at all: Setup creates them and the uninstaller removes them.
/// </summary>
internal static class SetupRegistration
{
    internal static void Write(SetupLayout layout, string displayVersion)
    {
        WriteMarker(layout);
        WriteUninstallEntry(layout, displayVersion);
    }

    private static void WriteMarker(SetupLayout layout)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SetupLayout.MarkerSubKey, writable: true)
            ?? throw new SetupException(SetupFailure.RegistrationUnavailable);
        key.SetValue(SetupLayout.MarkerSchemaValueName, SetupLayout.RegistrationSchemaVersion, RegistryValueKind.String);
        key.SetValue(SetupLayout.MarkerProgramRootValueName, layout.ProgramRoot, RegistryValueKind.String);
    }

    private static void WriteUninstallEntry(SetupLayout layout, string displayVersion)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SetupLayout.UninstallSubKey, writable: true)
            ?? throw new SetupException(SetupFailure.RegistrationUnavailable);
        key.SetValue("DisplayName", SetupLayout.ProductDisplayName, RegistryValueKind.String);
        key.SetValue("Publisher", SetupLayout.ProductPublisher, RegistryValueKind.String);
        key.SetValue("DisplayVersion", displayVersion, RegistryValueKind.String);
        key.SetValue("InstallLocation", layout.ProgramRoot, RegistryValueKind.String);
        key.SetValue("UninstallString", $"\"{layout.UninstallerPath}\" --uninstall", RegistryValueKind.String);
    }

    /// <summary>
    /// Removes both registration items and prunes the product key only when it is
    /// left empty, so a shared <c>Software\GameBuddy</c> tree is never taken away
    /// from another GameBuddy component.
    /// </summary>
    internal static void Remove()
    {
        Registry.CurrentUser.DeleteSubKeyTree(SetupLayout.UninstallSubKey, throwOnMissingSubKey: false);
        Registry.CurrentUser.DeleteSubKeyTree(SetupLayout.MarkerSubKey, throwOnMissingSubKey: false);
        PruneEmptyAncestors(@"Software\GameBuddy\Registration");
        PruneEmptyAncestors(@"Software\GameBuddy");
    }

    private static void PruneEmptyAncestors(string subKey)
    {
        using var key = Registry.CurrentUser.OpenSubKey(subKey, writable: false);
        if (key is null)
        {
            return;
        }

        if (key.GetValueNames().Length != 0 || key.GetSubKeyNames().Length != 0)
        {
            return;
        }

        key.Dispose();
        Registry.CurrentUser.DeleteSubKeyTree(subKey, throwOnMissingSubKey: false);
    }
}
