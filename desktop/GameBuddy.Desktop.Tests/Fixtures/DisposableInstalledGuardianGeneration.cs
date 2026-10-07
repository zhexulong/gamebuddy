using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;

namespace GameBuddy.Desktop.Tests.Fixtures;

/// <summary>Test-only consumer of the canonical Host production artifact publisher.</summary>
/// <remarks>
/// The installed generation can come from two places. By default it is published here and now through
/// the canonical publisher, which typechecks the whole Host production closure — so a lane part-way
/// through an unrelated Host edit reddens every test in this assembly. Setting
/// <see cref="PrebuiltGenerationRootEnvironmentVariable"/> to an already-published generation payload
/// root installs THAT generation instead and never reaches the publisher, which is what a run that is
/// only about the launcher needs. There is no fallback between the two: a fixture path that is set but
/// unusable fails closed, so a misconfigured harness can never hide behind a fresh build.
/// </remarks>
internal sealed class DisposableInstalledGuardianGeneration : IAsyncDisposable
{
    /// <summary>
    /// Optional path to a directory shaped like the publisher's output root: `current.json` plus exactly
    /// one `generations/&lt;id&gt;/`. Point it at the output of
    /// `node host/scripts/build-desktop-launcher-test-generation.mjs &lt;root&gt; &lt;runtime&gt; --full-runtime-tree`.
    /// The native guardian fixture pair under `host/native/windows-bootstrap-guardian/.dist/fixtures` must
    /// already exist (that is a .NET artifact of this repository's own helper, not a Host source artifact).
    /// </summary>
    internal const string PrebuiltGenerationRootEnvironmentVariable = "GAMEBUDDY_DESKTOP_TEST_GENERATION_ROOT";

    private static readonly Lazy<Task<string>> CanonicalProgramRoot = new(BuildCanonicalProgramRootAsync);
    private readonly string root;
    private string? generationsJunction;
    private string? generationsTarget;

    private DisposableInstalledGuardianGeneration(string root) => this.root = root;

    internal string LocalApplicationData => root;
    internal string ProgramRoot => Path.Combine(root, "Programs", "GameBuddy");
    internal string CurrentPointerPath => Path.Combine(ProgramRoot, "current.json");
    internal string GenerationRoot => Directory.GetDirectories(Path.Combine(ProgramRoot, "generations")).Single();
    internal string GuardianPairRoot => Path.Combine(GenerationRoot, "native", "windows-bootstrap-guardian", "win-x64");
    internal string GuardianExePath => Path.Combine(GuardianPairRoot, "GameBuddy.WindowsBootstrapGuardian.exe");
    internal string TestGuardianExePath => Path.Combine(root, "fixtures", "GameBuddy.WindowsBootstrapGuardian.Test.exe");
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
            File.Copy(Path.Combine(await CanonicalFixtureRoot.Value.ConfigureAwait(false), "GameBuddy.WindowsBootstrapGuardian.Test.exe"), fixture.TestGuardianExePath);
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

    private static Task<string> BuildCanonicalFixtureRootAsync()
    {
        // The guardian fixture pair is this repository's own native helper built by
        // `buildWindowsBootstrapGuardian()`, which the canonical publisher runs for its own Host build and
        // the prebuilt-generation path deliberately does not. It is a .NET artifact of the helper's
        // sources, not of the Host TypeScript closure, so it does not couple a run to other lanes' Host
        // edits either way; it only has to exist.
        var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "host", "native", "windows-bootstrap-guardian", ".dist", "fixtures"));
        if (!File.Exists(Path.Combine(root, "GameBuddy.WindowsBootstrapGuardian.Test.exe")))
            throw new InvalidOperationException($"desktop_test_guardian_fixture_missing:{root} (run `node host/scripts/build-windows-bootstrap-guardian.mjs`)");
        return Task.FromResult(root);
    }

    private static async Task<string> BuildCanonicalProgramRootAsync()
    {
        var templateRoot = Path.Combine(Path.GetTempPath(), "GameBuddy.Desktop.Tests", "canonical-host-generation", Guid.NewGuid().ToString("N"));
        var programRoot = Path.Combine(templateRoot, "Programs", "GameBuddy");
        var prebuilt = Environment.GetEnvironmentVariable(PrebuiltGenerationRootEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(prebuilt))
        {
            CopyDirectory(RequirePublishedGenerationRoot(prebuilt), programRoot);
            return programRoot;
        }
        var script = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "host", "scripts", "build-desktop-launcher-test-generation.mjs"));
        var fixtureRuntimeRoot = Path.Combine(AppContext.BaseDirectory, "Fixtures", "ExactChildBootstrapFixture");
        if (!File.Exists(Path.Combine(fixtureRuntimeRoot, "node.exe")))
            throw new InvalidOperationException("The self-contained exact-child fixture was not published.");
        await RunHostPublisherAsync(script, programRoot, fixtureRuntimeRoot).ConfigureAwait(false);
        return programRoot;
    }

    /// <summary>Structural admission for a fixture generation root; every refusal names what is wrong.</summary>
    internal static string RequirePublishedGenerationRoot(string candidate)
    {
        if (string.IsNullOrWhiteSpace(candidate)) throw new InvalidOperationException("desktop_test_generation_fixture_path_empty");
        string root;
        try { root = Path.GetFullPath(candidate); }
        catch (Exception error) { throw new InvalidOperationException($"desktop_test_generation_fixture_path_invalid:{candidate}", error); }
        if (!File.Exists(Path.Combine(root, "current.json")))
            throw new InvalidOperationException($"desktop_test_generation_fixture_current_pointer_missing:{root}");
        var generationsRoot = Path.Combine(root, "generations");
        string[] generations = Directory.Exists(generationsRoot) ? Directory.GetDirectories(generationsRoot) : [];
        if (generations.Length != 1)
            throw new InvalidOperationException($"desktop_test_generation_fixture_generation_count:{generations.Length}");
        if (!File.Exists(Path.Combine(generations[0], "host-runtime-admission.json")))
            throw new InvalidOperationException($"desktop_test_generation_fixture_host_runtime_admission_missing:{generations[0]}");
        if (!File.Exists(Path.Combine(generations[0], "runtime", "node.exe")))
            throw new InvalidOperationException($"desktop_test_generation_fixture_runtime_missing:{generations[0]}");
        return root;
    }

    internal void ReplaceHostRuntimeWithFixture()
    {
        var sourceDirectory = Path.GetDirectoryName(HostRuntimeFixturePath)!;
        if (sourceDirectory is null || !Directory.Exists(sourceDirectory)) throw new InvalidOperationException("The Desktop Host runtime fixture was not published.");
        var destinationDirectory = Path.GetDirectoryName(ExactChildRuntimePath)!;
        // The fixture is a self-contained managed runtime image: the runtime/
        // directory must receive the entire publish closure (hostfxr, coreclr,
        // hostpolicy and the framework DLLs) so the renamed node.exe can start.
        foreach (var sourceFile in Directory.EnumerateFiles(sourceDirectory))
        {
            var destination = Path.Combine(destinationDirectory, Path.GetFileName(sourceFile));
            File.Copy(sourceFile, destination, overwrite: true);
        }
        // The replacement node.exe is the managed fixture host; it is always
        // run through the hostfxr apphost of the copied fixture pair.
        File.Copy(Path.Combine(sourceDirectory, "DesktopHostRuntimeFixture.exe"), ExactChildRuntimePath, overwrite: true);
        foreach (var extension in new[] { ".dll", ".deps.json", ".runtimeconfig.json" })
        {
            var source = Path.Combine(sourceDirectory, "DesktopHostRuntimeFixture" + extension);
            var destination = Path.Combine(destinationDirectory, "node" + extension);
            if (source != destination) File.Copy(source, destination, overwrite: true);
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
