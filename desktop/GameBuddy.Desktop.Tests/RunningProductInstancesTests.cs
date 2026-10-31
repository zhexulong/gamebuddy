using System.Diagnostics;
using GameBuddy.Setup;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The install refuses to overwrite a program root whose images are running.
///
/// The defect this closes: an install extracts the payload over the generation the pointer
/// names, deletes the generations the payload no longer carries, and copies the uninstaller
/// over the one already there. Windows refuses to replace or delete a file a process has
/// loaded, and that refusal used to arrive partway through - after generation directories had
/// been deleted and before the new payload was complete - with nothing telling the player to
/// close the product and try again.
///
/// The detection is asserted against processes this test starts and owns, not against whatever
/// the machine happens to be running: each case copies a real executable into the program root
/// and runs that copy, so the fact under test (`does a running image live inside this root`) is
/// the one a player's machine produces.
/// </summary>
public sealed class RunningProductInstancesTests
{
    [Fact]
    public void A_running_image_inside_the_program_root_is_detected()
    {
        using var scratch = new ScratchLocalApplicationData();
        var layout = SetupLayout.Resolve(scratch.Path);
        Directory.CreateDirectory(layout.ProgramRoot);
        using var holder = HeldImage.Start(Path.Combine(layout.ProgramRoot, "GameBuddy.Desktop.exe"));

        var running = RunningProductInstances.Detect(layout);

        Assert.Contains(holder.ProcessName, running, StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_running_image_is_detected_under_a_name_the_installer_never_names()
    {
        // The check is "is this image inside the root the install owns", derived from the layout,
        // not "is this one of the executables we expect". A copy the player renamed, or a helper
        // a later generation adds, is covered without an edit here.
        using var scratch = new ScratchLocalApplicationData();
        var layout = SetupLayout.Resolve(scratch.Path);
        Directory.CreateDirectory(layout.ProgramRoot);
        using var holder = HeldImage.Start(Path.Combine(layout.ProgramRoot, "renamed-copy (1).exe"));

        Assert.Contains(holder.ProcessName, RunningProductInstances.Detect(layout), StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_running_image_outside_the_program_root_is_not_reported()
    {
        using var scratch = new ScratchLocalApplicationData();
        var layout = SetupLayout.Resolve(scratch.Path);
        Directory.CreateDirectory(layout.ProgramRoot);
        using var holder = HeldImage.Start(Path.Combine(scratch.Path, "elsewhere", "GameBuddy.Desktop.exe"));

        Assert.DoesNotContain(holder.ProcessName, RunningProductInstances.Detect(layout), StringComparer.OrdinalIgnoreCase);
    }

    [Fact]
    public void The_installer_itself_is_never_reported_as_blocking()
    {
        using var scratch = new ScratchLocalApplicationData();
        var layout = SetupLayout.Resolve(scratch.Path);
        Directory.CreateDirectory(layout.ProgramRoot);

        using var self = Process.GetCurrentProcess();
        var blocking = RunningProductInstances.Blocking(layout, [self]);

        // A self-check that reported itself would refuse every install the player starts from
        // the installed uninstaller copy - the repair path.
        Assert.Empty(blocking);
    }

    [Fact]
    public void The_install_refuses_before_it_writes_anything()
    {
        // The end of the wiring: the refusal happens before the first write, so a player who runs
        // Setup with the product open keeps the install they had instead of a half-delivered one.
        // The program root is asserted unchanged rather than assumed.
        using var scratch = new ScratchLocalApplicationData();
        var layout = SetupLayout.Resolve(scratch.Path);
        Directory.CreateDirectory(layout.ProgramRoot);
        using var holder = HeldImage.Start(Path.Combine(layout.ProgramRoot, "GameBuddy.Desktop.exe"));

        var refused = Assert.Throws<SetupException>(() => GameBuddy.Setup.Program.RefuseWhenProductRunning(layout));

        Assert.Equal(SetupFailure.ProductRunning, refused.Failure);
        Assert.Contains("Close GameBuddy", refused.Detail ?? string.Empty, StringComparison.Ordinal);
        // The program root still holds exactly the one file this case put there: no pointer, no
        // generation and no uninstaller were written behind the refusal.
        Assert.Equal(["GameBuddy.Desktop.exe"], Directory.GetFileSystemEntries(layout.ProgramRoot).Select(Path.GetFileName));
    }

    [Fact]
    public void The_install_runs_the_refusal_before_its_first_write()
    {
        // Ordering, which no behavior case can observe here: calling Install with a payload would
        // write the current user's real registry, and this suite has no store seam for it. So the
        // shape is asserted - the guard is the first statement of the install half, ahead of the
        // payload extraction, the uninstaller copy and the registration.
        var source = File.ReadAllText(Path.Combine(RepositoryRoot(), "desktop", "installer", "GameBuddy.Setup", "Program.cs"));
        var install = source[source.IndexOf("private static void Install(", StringComparison.Ordinal)..];
        install = install[..install.IndexOf("\n    }", StringComparison.Ordinal)];
        var guard = install.IndexOf("RefuseWhenProductRunning(", StringComparison.Ordinal);
        Assert.True(guard >= 0, "the install half must ask whether the product is running");
        Assert.True(guard < install.IndexOf("LayPayloadIntoProgramRoot(", StringComparison.Ordinal), "the guard must run before the payload is laid down");
        Assert.True(guard < install.IndexOf("SetupRegistration.Write(", StringComparison.Ordinal), "the guard must run before the registration is written");
        Assert.True(guard < install.IndexOf("InstallUninstaller(", StringComparison.Ordinal), "the guard must run before the uninstaller is copied over");
    }

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

    /// <summary>
    /// A real, long-lived process whose image is a copy of a platform executable placed wherever
    /// the case wants one. It is what makes the detection falsifiable: the image is in a real
    /// process, so a check that only reads a list cannot pass it.
    /// </summary>
    private sealed class HeldImage : IDisposable
    {
        private readonly Process process;

        private HeldImage(Process process) => this.process = process;

        internal string ProcessName => process.ProcessName;

        internal static HeldImage Start(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.Copy(Path.Combine(Environment.SystemDirectory, "ping.exe"), path, overwrite: true);
            // Long enough that no case races its own holder, short enough to never outlive a run.
            var process = Process.Start(new ProcessStartInfo(path, ["-n", "120", "127.0.0.1"])
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            }) ?? throw new InvalidOperationException("holder process did not start");
            return new HeldImage(process);
        }

        public void Dispose()
        {
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                process.WaitForExit(10_000);
            }
            finally
            {
                process.Dispose();
            }
        }
    }

    private sealed class ScratchLocalApplicationData : IDisposable
    {
        internal ScratchLocalApplicationData() =>
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "GameBuddy.Desktop.Tests", "running-product", Guid.NewGuid().ToString("N"));

        internal string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path)) Directory.Delete(Path, recursive: true);
        }
    }
}
