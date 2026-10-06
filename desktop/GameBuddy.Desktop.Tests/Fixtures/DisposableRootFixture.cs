using System.Diagnostics;

namespace GameBuddy.Desktop.Tests.Fixtures;

internal sealed class DisposableRootFixture : IAsyncDisposable, ILocalApplicationDataProvider
{
    private string? reparseTarget;

    private DisposableRootFixture(string localApplicationData, CurrentUserRootRegistrationRecord registration)
    {
        LocalApplicationData = localApplicationData;
        Registration = registration;
    }

    internal string LocalApplicationData { get; }

    internal CurrentUserRootRegistrationRecord Registration { get; private set; }

    // The mutable roots are derived, never registered. The fixture keeps the
    // derivation in one place so tests can create and probe them directly.
    internal string ProgramRoot => Registration.ProgramRoot;

    internal string DataRoot => Path.Combine(LocalApplicationData, "GameBuddy", "data");

    internal string OperationalRoot => Path.Combine(LocalApplicationData, "GameBuddy", "operational");

    internal string PresentationRoot => Path.Combine(LocalApplicationData, "GameBuddy", "presentation");

    internal string[] AllRoots => [ProgramRoot, DataRoot, OperationalRoot, PresentationRoot];

    internal static Task<DisposableRootFixture> CreateAsync()
    {
        var local = Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", Guid.NewGuid().ToString("N"));
        var registration = new CurrentUserRootRegistrationRecord(
            CurrentUserRootRegistration.SchemaVersion,
            Path.Combine(local, "Programs", "GameBuddy"));
        var fixture = new DisposableRootFixture(local, registration);
        foreach (var root in fixture.AllRoots)
        {
            Directory.CreateDirectory(root);
        }

        return Task.FromResult(fixture);
    }

    internal void ReplaceDataBoundaryWithReparsePoint() => ReplaceWithReparsePoint(DataRoot);

    internal void ReplaceProgramsAncestorWithReparsePoint() => ReplaceWithReparsePoint(Path.Combine(LocalApplicationData, "Programs"));

    private void ReplaceWithReparsePoint(string boundary)
    {
        if (reparseTarget is not null)
        {
            throw new InvalidOperationException("A reparse fixture is already active.");
        }

        Directory.Delete(boundary, recursive: true);
        reparseTarget = Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", $"reparse-{Guid.NewGuid():N}");
        Directory.CreateDirectory(reparseTarget);
        foreach (var root in AllRoots)
        {
            if (root.StartsWith(boundary + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                Directory.CreateDirectory(Path.Combine(reparseTarget, Path.GetRelativePath(boundary, root)));
            }
        }

        using var process = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{boundary}\" \"{reparseTarget}\"")
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

    internal void RestoreCanonicalBoundaries()
    {
        if (reparseTarget is null)
        {
            return;
        }

        var reparseBoundary = FindReparseBoundary();
        Directory.Delete(reparseBoundary);
        Directory.Delete(reparseTarget, recursive: true);
        foreach (var root in AllRoots)
        {
            Directory.CreateDirectory(root);
        }

        reparseTarget = null;
    }

    // The marker carries the program root. Redirecting it onto a mutable root is
    // the "program root adoption" the layout must still refuse.
    internal void AdoptDataRootAsProgramRoot()
    {
        Registration = Registration with { ProgramRoot = DataRoot };
    }

    internal void ReplaceSchema(string schema)
    {
        Registration = Registration with { Schema = schema };
    }

    private string FindReparseBoundary()
    {
        foreach (var candidate in new[] { Path.Combine(LocalApplicationData, "Programs"), DataRoot })
        {
            if (Directory.Exists(candidate) && (File.GetAttributes(candidate) & FileAttributes.ReparsePoint) != 0)
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("The reparse fixture boundary was not found.");
    }

    string ILocalApplicationDataProvider.GetLocalApplicationDataPath() => LocalApplicationData;

    public ValueTask DisposeAsync()
    {
        RestoreCanonicalBoundaries();
        if (Directory.Exists(LocalApplicationData))
        {
            Directory.Delete(LocalApplicationData, recursive: true);
        }

        return ValueTask.CompletedTask;
    }
}
