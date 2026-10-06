using System.Diagnostics;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The launcher-owned pre-launch provisioning step: the three mutable roots are
/// created when they are absent, a second run is a no-op, and a reparse or
/// non-ordinary boundary is refused rather than adopted. The fixture reproduces
/// the exact state a successful install leaves, because that is the state the
/// first launch failed on: the registration is written and the program root is
/// installed, and none of the three mutable roots exist.
/// </summary>
public sealed class MutableRootsProvisioningTests
{
    [Fact]
    public void Provisioning_creates_only_the_three_mutable_roots_and_the_layout_then_derives()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var fixture = InstalledLayoutFixture.Create();

        Assert.False(Directory.Exists(fixture.DataRoot));
        Assert.False(Directory.Exists(fixture.OperationalRoot));
        Assert.False(Directory.Exists(fixture.PresentationRoot));

        CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture);

        Assert.True(Directory.Exists(fixture.DataRoot));
        Assert.True(Directory.Exists(fixture.OperationalRoot));
        Assert.True(Directory.Exists(fixture.PresentationRoot));
        // The step exists so the very next read of the layout succeeds.
        var layout = CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture);
        Assert.Equal(fixture.DataRoot, layout.DataRoot);
        Assert.Equal(fixture.OperationalRoot, layout.OperationalRoot);
        Assert.Equal(fixture.PresentationRoot, layout.PresentationRoot);
        Assert.Equal(fixture.ProgramRoot, layout.ProgramRoot);
    }

    [Fact]
    public void Provisioning_never_creates_the_program_root()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var fixture = InstalledLayoutFixture.Create(uninstalled: true);

        // A registration whose program root was never installed must stay refused:
        // Setup installs the program root, the launcher only owns the mutable roots.
        CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture);

        Assert.True(Directory.Exists(fixture.DataRoot));
        Assert.False(Directory.Exists(fixture.ProgramRoot));
        Assert.Throws<RootLayoutUnavailableException>(() => CurrentUserRootLayout.DeriveForTesting(fixture.Registration, fixture));
    }

    [Fact]
    public void Provisioning_is_idempotent_and_leaves_existing_content_exactly_as_it_is()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var fixture = InstalledLayoutFixture.Create();
        CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture);

        var sentinel = Path.Combine(fixture.DataRoot, "durable-sentinel.bin");
        File.WriteAllBytes(sentinel, [1, 2, 3]);
        var dataWritten = Directory.GetLastWriteTimeUtc(fixture.DataRoot);

        // A second run changes nothing and does not fail.
        CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture);
        CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture);

        Assert.Equal([1, 2, 3], File.ReadAllBytes(sentinel));
        Assert.Equal(dataWritten, Directory.GetLastWriteTimeUtc(fixture.DataRoot));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.PresentationRoot));
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.OperationalRoot));
    }

    [Fact]
    public void Provisioning_refuses_a_reparse_point_on_the_shared_product_ancestor_and_adopts_nothing()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var fixture = InstalledLayoutFixture.Create();
        fixture.ReplaceProductAncestorWithReparsePoint();

        Assert.Throws<MutableRootsUnavailableException>(
            () => CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture));

        // Refused, not followed: nothing was created through the link.
        Assert.Empty(Directory.EnumerateFileSystemEntries(fixture.ReparseTarget!));
    }

    [Fact]
    public void Provisioning_refuses_a_mutable_root_that_is_itself_a_reparse_point()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var fixture = InstalledLayoutFixture.Create();
        var productRoot = Directory.CreateDirectory(Path.Combine(fixture.LocalApplicationData, "GameBuddy")).FullName;
        fixture.LinkDirectory(Path.Combine(productRoot, "data"));

        Assert.Throws<MutableRootsUnavailableException>(
            () => CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture));

        // The first root was refused, so the step stopped instead of leaving a
        // partially provisioned layout a later read would accept.
        Assert.False(Directory.Exists(fixture.OperationalRoot));
        Assert.False(Directory.Exists(fixture.PresentationRoot));
    }

    [Fact]
    public void Provisioning_refuses_a_file_standing_where_a_mutable_root_belongs_and_keeps_it()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        using var fixture = InstalledLayoutFixture.Create();
        var occupied = Path.Combine(fixture.LocalApplicationData, "GameBuddy");
        File.WriteAllText(occupied, "not a directory");

        Assert.Throws<MutableRootsUnavailableException>(
            () => CurrentUserRootLayout.ProvisionMutableRoots(fixture.Registration, fixture));

        // The occupant is neither replaced nor adopted.
        Assert.True(File.Exists(occupied));
        Assert.Equal("not a directory", File.ReadAllText(occupied));
    }

    /// <summary>
    /// The layout a successful Setup leaves - registration plus installed program
    /// root - optionally without the program root so the "Setup installs it, the
    /// launcher does not" boundary stays provable.
    /// </summary>
    private sealed class InstalledLayoutFixture : ILocalApplicationDataProvider, IDisposable
    {
        private string? reparseTarget;

        private InstalledLayoutFixture(string localApplicationData, bool uninstalled)
        {
            LocalApplicationData = localApplicationData;
            // The user's LocalApplicationData always exists; only the program root
            // distinguishes "Setup has installed" from "Setup has not".
            Directory.CreateDirectory(localApplicationData);
            Registration = new CurrentUserRootRegistrationRecord(
                CurrentUserRootRegistration.SchemaVersion,
                Path.Combine(localApplicationData, "Programs", "GameBuddy"));
            if (!uninstalled)
            {
                Directory.CreateDirectory(Registration.ProgramRoot);
            }
        }

        internal string LocalApplicationData { get; }

        internal CurrentUserRootRegistrationRecord Registration { get; }

        internal string ProgramRoot => Registration.ProgramRoot;

        internal string DataRoot => Path.Combine(LocalApplicationData, "GameBuddy", "data");

        internal string OperationalRoot => Path.Combine(LocalApplicationData, "GameBuddy", "operational");

        internal string PresentationRoot => Path.Combine(LocalApplicationData, "GameBuddy", "presentation");

        internal string? ReparseTarget => reparseTarget;

        internal static InstalledLayoutFixture Create(bool uninstalled = false) =>
            new(Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", "provisioning", Guid.NewGuid().ToString("N")), uninstalled);

        /// <summary>The ancestor the three mutable roots share, replaced by a link.</summary>
        internal void ReplaceProductAncestorWithReparsePoint()
        {
            var boundary = Path.Combine(LocalApplicationData, "GameBuddy");
            reparseTarget = Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", "provisioning-target", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(reparseTarget);
            LinkDirectory(boundary, reparseTarget);
        }

        internal void LinkDirectory(string boundary, string? target = null)
        {
            var destination = target ?? reparseTarget ?? Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", "provisioning-target", Guid.NewGuid().ToString("N"));
            if (target is null && reparseTarget is null)
            {
                Directory.CreateDirectory(destination);
                reparseTarget = destination;
            }

            using var process = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{boundary}\" \"{destination}\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
            }) ?? throw new InvalidOperationException("Could not create the disposable reparse fixture.");
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException("Could not create the disposable reparse fixture.");
            }
        }

        string ILocalApplicationDataProvider.GetLocalApplicationDataPath() => LocalApplicationData;

        public void Dispose()
        {
            // A junction is removed as a link, never as the tree behind it.
            var link = Path.Combine(LocalApplicationData, "GameBuddy");
            if (Directory.Exists(link) && (File.GetAttributes(link) & FileAttributes.ReparsePoint) != 0)
            {
                Directory.Delete(link);
            }

            foreach (var candidate in new[] { Path.Combine(link, "data"), Path.Combine(link, "operational"), Path.Combine(link, "presentation") })
            {
                if (Directory.Exists(candidate) && (File.GetAttributes(candidate) & FileAttributes.ReparsePoint) != 0)
                {
                    Directory.Delete(candidate);
                }
            }

            BestEffort(() => Directory.Delete(LocalApplicationData, recursive: true));
            if (reparseTarget is not null)
            {
                BestEffort(() => Directory.Delete(reparseTarget, recursive: true));
            }
        }

        private static void BestEffort(Action action)
        {
            try
            {
                action();
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or DirectoryNotFoundException)
            {
                // Disposable test cleanup only.
            }
        }
    }
}
