using System.ComponentModel;
using System.Diagnostics;

namespace GameBuddy.Setup;

/// <summary>
/// The installed product's own running images, as seen by an install that is about to overwrite
/// them.
///
/// An install writes inside the program root: it extracts the payload over the generation the
/// pointer names, deletes generations the payload no longer carries, and copies the uninstaller
/// over the one already there. Windows refuses to replace or delete a file a process has loaded,
/// and the refusal arrives partway through - the new generation directories are already on disk
/// and an older generation is already half-deleted when the first locked file is reached. A
/// player who runs Setup while GameBuddy is open therefore got a failure with the install in a
/// state nobody can name, and no sentence telling them what to do.
///
/// The test is "does any running image live inside the program root this install owns", which is
/// derived from the layout rather than from a list of executable names: a helper added to the
/// program root later is covered without an edit here, and an unrelated <c>node.exe</c> elsewhere
/// on the machine is never mistaken for one of ours.
/// </summary>
internal static class RunningProductInstances
{
    /// <summary>
    /// The process names holding an image inside the program root, empty when the product is not
    /// running. This process is not one of them: an install can legitimately be started from the
    /// copy under <c>uninstall\</c>, and refusing itself would make that repair impossible.
    /// </summary>
    internal static IReadOnlyList<string> Detect(SetupLayout layout)
    {
        var running = Process.GetProcesses();
        try
        {
            return Blocking(layout, running);
        }
        finally
        {
            foreach (var process in running)
            {
                process.Dispose();
            }
        }
    }

    /// <summary>
    /// The decision itself, separated from enumeration so a case can hand it a process it started
    /// and owns rather than assert against whatever the machine happens to be running.
    /// </summary>
    internal static IReadOnlyList<string> Blocking(SetupLayout layout, IEnumerable<Process> running)
    {
        var programRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(layout.ProgramRoot));
        var self = Environment.ProcessId;
        string[]? installedNames = null;
        var blocking = new List<string>();
        foreach (var process in running)
        {
            int id;
            string name;
            try
            {
                id = process.Id;
                name = process.ProcessName;
            }
            catch (Exception exception) when (exception is InvalidOperationException or Win32Exception)
            {
                // Ended between the snapshot and this read; a process that no longer exists holds
                // no file.
                continue;
            }

            if (id == self)
            {
                continue;
            }

            string? image;
            try
            {
                image = process.MainModule?.FileName;
            }
            catch (Exception exception) when (exception is Win32Exception or InvalidOperationException or NotSupportedException)
            {
                // Another account's process, or one elevated above this installer, cannot be
                // asked where its image lives. Its NAME is then the only fact left, so it is
                // matched against the executables that actually exist in the program root -
                // still the layout's population, never the machine's.
                image = null;
            }

            var holds = image is not null
                ? IsInside(programRoot, image)
                : (installedNames ??= InstalledExecutableNames(programRoot)).Contains(name, StringComparer.OrdinalIgnoreCase);
            if (holds)
            {
                blocking.Add(name);
            }
        }

        return blocking;
    }

    private static bool IsInside(string programRoot, string image)
    {
        string full;
        try
        {
            full = Path.GetFullPath(image);
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }

        return StringComparer.OrdinalIgnoreCase.Equals(full, programRoot) ||
            full.StartsWith(programRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The executable names the program root currently holds, without their extension, which is
    /// the form <see cref="Process.ProcessName"/> reports.
    /// </summary>
    private static string[] InstalledExecutableNames(string programRoot)
    {
        if (!Directory.Exists(programRoot))
        {
            return [];
        }

        try
        {
            return Directory
                .EnumerateFiles(programRoot, "*.exe", SearchOption.AllDirectories)
                .Select(path => Path.GetFileNameWithoutExtension(path))
                .ToArray();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // A program root that cannot be walked is one this install is about to fail on
            // anyway; it contributes no names rather than turning the check into the failure.
            return [];
        }
    }
}
