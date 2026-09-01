using System.Diagnostics;

namespace GameBuddy.Desktop.Tests.Fixtures;

/// <summary>Test-only consumer of the canonical Host production artifact publisher.</summary>
internal sealed class DisposableInstalledGuardianGeneration : IAsyncDisposable
{
    private static readonly Lazy<Task<string>> CanonicalProgramRoot = new(BuildCanonicalProgramRootAsync);
    private readonly string root;
    private string? generationsJunction;
    private string? generationsTarget;

    private DisposableInstalledGuardianGeneration(string root) => this.root = root;

    internal string LocalApplicationData => root;
    internal string ProgramRoot => Path.Combine(root, "Programs", "GameBuddy");
    internal string CurrentPointerPath => Path.Combine(ProgramRoot, "current.json");
    internal string GenerationRoot => Directory.GetDirectories(Path.Combine(ProgramRoot, "generations")).Single();
    internal string GuardianPairRoot => Path.Combine(GenerationRoot, "native", "windows-stardew-bootstrap-guardian", "win-x64");
    internal string GuardianExePath => Path.Combine(GuardianPairRoot, "GameBuddy.WindowsStardewBootstrapGuardian.exe");
    internal string TestGuardianExePath => Path.Combine(root, "fixtures", "GameBuddy.WindowsStardewBootstrapGuardian.Test.exe");
    internal string GenerationId => Path.GetFileName(GenerationRoot);

    internal static async Task<DisposableInstalledGuardianGeneration> BuildAsync()
    {
        var fixture = new DisposableInstalledGuardianGeneration(Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", Guid.NewGuid().ToString("N")));
        try
        {
            Directory.CreateDirectory(fixture.root);
            CopyDirectory(await CanonicalProgramRoot.Value.ConfigureAwait(false), fixture.ProgramRoot);
            Directory.CreateDirectory(Path.GetDirectoryName(fixture.TestGuardianExePath)!);
            File.Copy(Path.Combine(await CanonicalFixtureRoot.Value.ConfigureAwait(false), "GameBuddy.WindowsStardewBootstrapGuardian.Test.exe"), fixture.TestGuardianExePath);
            return fixture;
        }
        catch
        {
            await fixture.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static readonly Lazy<Task<string>> CanonicalFixtureRoot = new(BuildCanonicalFixtureRootAsync);

    private static async Task<string> BuildCanonicalFixtureRootAsync()
    {
        _ = await CanonicalProgramRoot.Value.ConfigureAwait(false);
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "host", "native", "windows-stardew-bootstrap-guardian", ".dist", "fixtures"));
    }

    private static async Task<string> BuildCanonicalProgramRootAsync()
    {
        var templateRoot = Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", "canonical-host-generation", Guid.NewGuid().ToString("N"));
        var programRoot = Path.Combine(templateRoot, "Programs", "GameBuddy");
        var script = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "host", "scripts", "build-desktop-launcher-test-generation.mjs"));
        await RunHostPublisherAsync(script, programRoot).ConfigureAwait(false);
        return programRoot;
    }

    internal void ReplaceGenerationsWithJunction()
    {
        var generations = Path.Combine(ProgramRoot, "generations");
        var replacement = Path.Combine(root, "self-consistent-generations");
        Directory.Move(generations, replacement);
        generationsJunction = generations;
        generationsTarget = replacement;
        using var process = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{generations}\" \"{replacement}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        }) ?? throw new InvalidOperationException("Could not create generations junction.");
        process.WaitForExit();
        if (process.ExitCode != 0) throw new InvalidOperationException("Could not create generations junction.");
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.EnumerateFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        foreach (var directory in Directory.EnumerateDirectories(source)) CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }

    private static async Task RunHostPublisherAsync(string script, string outputRoot)
    {
        using var process = Process.Start(new ProcessStartInfo("node.exe", $"\"{script}\" \"{outputRoot}\"")
        {
            WorkingDirectory = Path.GetDirectoryName(script)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        }) ?? throw new InvalidOperationException("Could not start the canonical Host production artifact publisher.");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(15)).ConfigureAwait(false); }
        catch (TimeoutException) { try { process.Kill(entireProcessTree: true); } catch { } throw new InvalidOperationException("The canonical Host production artifact publisher timed out."); }
        if (process.ExitCode != 0) throw new InvalidOperationException($"The canonical Host production artifact publisher failed: {await stderr.ConfigureAwait(false)}");
        _ = await stdout.ConfigureAwait(false);
        _ = await stderr.ConfigureAwait(false);
    }

    public ValueTask DisposeAsync()
    {
        if (generationsJunction is not null && Directory.Exists(generationsJunction)) Directory.Delete(generationsJunction);
        if (generationsTarget is not null && Directory.Exists(generationsTarget)) Directory.Delete(generationsTarget, recursive: true);
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        return ValueTask.CompletedTask;
    }
}
