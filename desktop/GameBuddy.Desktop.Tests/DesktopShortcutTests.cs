using GameBuddy.Setup;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The desktop entry the installer lays down.
///
/// A player who installed the product and then cannot find it has no product, and the Start
/// menu entry the registration provides names a version while the desktop icon is what people
/// actually double-click. The shortcut is created through the platform's own shell object, so
/// these tests drive a real scratch desktop folder and read back the link that was written.
///
/// Its failure behaviour is part of the contract: the install has already completed by the
/// time this runs, so a desktop folder that cannot be written (a redirected profile, a
/// policy-locked desktop) must leave the product installed and startable rather than fail the
/// whole setup.
/// </summary>
public sealed class DesktopShortcutTests
{
    [Fact]
    public void TryCreate_writes_a_link_to_the_installed_launcher_into_the_desktop_folder()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var scratch = new ScratchDirectory();
        var launcher = Path.Combine(scratch.Path, "GameBuddy.Desktop.exe");
        File.WriteAllText(launcher, "launcher");

        Assert.True(DesktopShortcut.TryCreate(scratch.Path, launcher, scratch.Path));

        var link = Path.Combine(scratch.Path, DesktopShortcut.FileName);
        Assert.True(File.Exists(link));
        // The name is the product's own, in the player's language, and it is a .lnk the shell
        // resolves rather than a file this product reimplements.
        Assert.EndsWith(".lnk", DesktopShortcut.FileName, StringComparison.Ordinal);
        Assert.Contains("星露谷", DesktopShortcut.FileName, StringComparison.Ordinal);
        // The link actually points at the launcher. Asserting only that a file appeared would
        // pass for a link aimed anywhere - including at the folder itself - and the player would
        // double-click an icon that opens nothing.
        Assert.Equal(Path.GetFullPath(launcher), DesktopShortcut.ReadTargetForTesting(link));
    }

    [Fact]
    public void TryCreate_reports_absence_instead_of_throwing_when_it_cannot_write()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var scratch = new ScratchDirectory();
        var launcher = Path.Combine(scratch.Path, "GameBuddy.Desktop.exe");
        File.WriteAllText(launcher, "launcher");

        // A desktop folder that does not exist: the caller is told, and nothing is thrown -
        // this runs after the install already succeeded.
        Assert.False(DesktopShortcut.TryCreate(Path.Combine(scratch.Path, "no-such-desktop"), launcher, scratch.Path));
        // A launcher that is not there is not a shortcut target either.
        Assert.False(DesktopShortcut.TryCreate(scratch.Path, Path.Combine(scratch.Path, "missing.exe"), scratch.Path));
    }

    [Fact]
    public void Remove_deletes_only_the_link_this_installer_owns()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var scratch = new ScratchDirectory();
        var launcher = Path.Combine(scratch.Path, "GameBuddy.Desktop.exe");
        File.WriteAllText(launcher, "launcher");
        var playerFile = Path.Combine(scratch.Path, "holiday-photo.txt");
        File.WriteAllText(playerFile, "not ours");

        Assert.True(DesktopShortcut.TryCreate(scratch.Path, launcher, scratch.Path));
        DesktopShortcut.Remove(scratch.Path);

        Assert.False(File.Exists(Path.Combine(scratch.Path, DesktopShortcut.FileName)));
        // The uninstaller removes its own link and nothing else on the player's desktop.
        Assert.True(File.Exists(playerFile));
        // Removing it twice is not an error: a player who deleted the icon themselves already
        // has the postcondition.
        DesktopShortcut.Remove(scratch.Path);
    }

    private sealed class ScratchDirectory : IDisposable
    {
        internal string Path { get; } = Directory.CreateTempSubdirectory("gamebuddy-desktop-shortcut-").FullName;

        public void Dispose()
        {
            try
            {
                if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }
}
