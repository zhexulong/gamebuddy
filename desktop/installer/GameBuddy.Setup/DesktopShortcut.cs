namespace GameBuddy.Setup;

/// <summary>
/// The player's desktop entry: one <c>.lnk</c> pointing at the installed launcher.
///
/// The installer is the only party that knows where the program root is and that it has
/// just finished installing, so it is the only party that can create this. It writes a
/// standard Windows shortcut through the platform's own shell object (the same COM object
/// Explorer uses) rather than reimplementing a shell link: the format is undocumented and
/// a hand-built one shows up as a broken icon.
///
/// It is a convenience, never a precondition: a desktop folder that cannot be written (a
/// redirected profile, a policy-locked desktop) leaves the product installed and startable
/// from the Start menu entry the uninstaller registration already provides, so a failure
/// here is reported as one bounded code and does not fail the install.
/// </summary>
internal static class DesktopShortcut
{
    internal const string FileName = "星露谷AI伴侣.lnk";

    /// <summary>
    /// Creates (or replaces) the desktop shortcut for <paramref name="targetExecutable"/>.
    /// Returns false when the platform has no desktop shell to write to; a refusal here is
    /// never an install failure.
    /// </summary>
    internal static bool TryCreate(string desktopDirectory, string targetExecutable, string workingDirectory)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(desktopDirectory) || !Directory.Exists(desktopDirectory)) return false;
            if (!File.Exists(targetExecutable)) return false;
            var type = Type.GetTypeFromProgID("WScript.Shell");
            if (type is null) return false;
            dynamic? shell = Activator.CreateInstance(type);
            if (shell is null) return false;
            try
            {
                var shortcutPath = Path.Combine(desktopDirectory, FileName);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = targetExecutable;
                shortcut.WorkingDirectory = workingDirectory;
                shortcut.Description = "星露谷AI伴侣";
                shortcut.IconLocation = targetExecutable;
                shortcut.Save();
                return File.Exists(shortcutPath);
            }
            finally
            {
                System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
            }
        }
        catch (Exception exception) when (
            exception is System.Runtime.InteropServices.COMException
                or InvalidCastException
                or IOException
                or UnauthorizedAccessException
                or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// Reads back the target path of a shortcut this installer wrote. It exists for the test
    /// that proves the link points where it should: the shell object writes an undocumented
    /// format, so the only honest way to check it is to ask the same object to read it.
    /// </summary>
    internal static string? ReadTargetForTesting(string shortcutPath)
    {
        var type = Type.GetTypeFromProgID("WScript.Shell");
        if (type is null) return null;
        dynamic? shell = Activator.CreateInstance(type);
        if (shell is null) return null;
        try
        {
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            return (string?)shortcut.TargetPath;
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
        }
    }

    /// <summary>
    /// Removes the shortcut this installer created. Only the exact file name is touched, and
    /// a shortcut the player deleted themselves is not an error.
    /// </summary>
    internal static void Remove(string desktopDirectory)
    {
        if (string.IsNullOrWhiteSpace(desktopDirectory)) return;
        try
        {
            var path = Path.Combine(desktopDirectory, FileName);
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // The uninstaller reports one bounded code for the roots it owns; a shortcut left
            // behind in a locked desktop folder is not a reason to fail that whole operation.
        }
    }
}
