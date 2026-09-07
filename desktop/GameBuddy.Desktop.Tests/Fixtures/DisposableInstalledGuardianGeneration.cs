using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

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
    internal string ExactChildReportPath => Path.Combine(GenerationRoot, "runtime", "exact-child-bootstrap-report.json");
    internal string ExactChildRuntimePath => Path.Combine(GenerationRoot, "runtime", "node.exe");
    internal string HostRuntimeFixturePath => Path.Combine(AppContext.BaseDirectory, "Fixtures", "DesktopHostRuntimeFixture", "DesktopHostRuntimeFixture.exe");
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
            if (!File.Exists(fixture.HostRuntimeFixturePath)) throw new InvalidOperationException("The Desktop Host runtime fixture was not published.");
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
        var fixtureRuntimeRoot = Path.Combine(AppContext.BaseDirectory, "Fixtures", "ExactChildBootstrapFixture");
        if (!File.Exists(Path.Combine(fixtureRuntimeRoot, "node.exe")))
            throw new InvalidOperationException("The self-contained exact-child fixture was not published.");
        await RunHostPublisherAsync(script, programRoot, fixtureRuntimeRoot).ConfigureAwait(false);
        return programRoot;
    }

    internal void ReplaceHostRuntimeWithFixture()
    {
        var sourceDirectory = Path.GetDirectoryName(HostRuntimeFixturePath)!;
        var destinationDirectory = Path.GetDirectoryName(ExactChildRuntimePath)!;
        File.Copy(Path.Combine(sourceDirectory, "DesktopHostRuntimeFixture.exe"), ExactChildRuntimePath, overwrite: true);
        foreach (var extension in new[] { ".dll", ".deps.json", ".runtimeconfig.json" })
        {
            File.Copy(Path.Combine(sourceDirectory, "DesktopHostRuntimeFixture" + extension), Path.Combine(destinationDirectory, "DesktopHostRuntimeFixture" + extension), overwrite: true);
            File.Copy(Path.Combine(sourceDirectory, "DesktopHostRuntimeFixture" + extension), Path.Combine(destinationDirectory, "node" + extension), overwrite: true);
        }
        var admissionPath = Path.Combine(GenerationRoot, "host-runtime-admission.json");
        using var admission = JsonDocument.Parse(File.ReadAllBytes(admissionPath));
        var properties = admission.RootElement.EnumerateObject().ToDictionary(property => property.Name, property => property.Value.Clone(), StringComparer.Ordinal);
        properties["runtimeSha256"] = JsonDocument.Parse($"\"{DigestFile(ExactChildRuntimePath)}\"").RootElement.Clone();
        File.WriteAllText(admissionPath, JsonSerializer.Serialize(properties) + "\n");
        var admissionDigest = DigestFile(admissionPath);
        var pointerPath = Path.Combine(ProgramRoot, "current.json");
        using var pointer = JsonDocument.Parse(File.ReadAllBytes(pointerPath));
        var pointerProperties = pointer.RootElement.EnumerateObject().ToDictionary(property => property.Name, property => property.Value.Clone(), StringComparer.Ordinal);
        pointerProperties["runtimeAdmissionSha256"] = JsonDocument.Parse($"\"{admissionDigest}\"").RootElement.Clone();
        File.WriteAllText(pointerPath, JsonSerializer.Serialize(pointerProperties) + "\n");
    }

    private static string DigestFile(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

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

    private static async Task RunHostPublisherAsync(string script, string outputRoot, string fixtureRuntimeRoot)
    {
        var start = new ProcessStartInfo(FindTestPublisherNodeExecutable())
        {
            WorkingDirectory = Path.GetDirectoryName(script)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(script);
        start.ArgumentList.Add(outputRoot);
        start.ArgumentList.Add(fixtureRuntimeRoot);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Could not start the canonical Host production artifact publisher.");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromMinutes(15)).ConfigureAwait(false); }
        catch (TimeoutException) { try { process.Kill(entireProcessTree: true); } catch { } throw new InvalidOperationException("The canonical Host production artifact publisher timed out."); }
        if (process.ExitCode != 0) throw new InvalidOperationException($"The canonical Host production artifact publisher failed: {await stderr.ConfigureAwait(false)}");
        _ = await stdout.ConfigureAwait(false);
        _ = await stderr.ConfigureAwait(false);
    }

    // This interpreter is solely a test-harness dependency for the canonical publisher;
    // it is never copied into, advertised by, or admitted from the published generation.
    private static string FindTestPublisherNodeExecutable()
    {
        var systemNode = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(systemNode)) return systemNode;

        throw new InvalidOperationException("test_publisher_node_unavailable");
    }

    public ValueTask DisposeAsync()
    {
        if (generationsJunction is not null && Directory.Exists(generationsJunction)) Directory.Delete(generationsJunction);
        if (generationsTarget is not null && Directory.Exists(generationsTarget)) Directory.Delete(generationsTarget, recursive: true);
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        return ValueTask.CompletedTask;
    }
}
