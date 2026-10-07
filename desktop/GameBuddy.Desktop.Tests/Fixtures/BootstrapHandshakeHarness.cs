using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop.Tests.Fixtures;

/// <summary>
/// One installed generation whose Host runtime is the test fixture child, with the deployment
/// manifest the launcher's pre-launch check requires.
///
/// The fixture is a real child on the real anonymous pipes and the real authenticated broker, so a
/// test can drive the private bootstrap handshake exactly as production does and observe what the
/// launcher does with it: the child can refuse before its acknowledgement, announce a plan of
/// status frames, say it is waiting for its player, go quiet on a schedule, close its standard
/// output without an acknowledgement, or reach its own steady state.
/// </summary>
internal sealed class BootstrapHandshakeHarness : IAsyncDisposable
{
    private BootstrapHandshakeHarness(DisposableInstalledGuardianGeneration generation, CurrentUserRootLayout layout, InstalledGenerationSelection selection, AdmittedHostRuntime runtime, RuntimeSupervisor supervisor)
    {
        Generation = generation;
        Layout = layout;
        Selection = selection;
        Runtime = runtime;
        Supervisor = supervisor;
    }

    internal DisposableInstalledGuardianGeneration Generation { get; }
    internal CurrentUserRootLayout Layout { get; }
    internal InstalledGenerationSelection Selection { get; }
    internal AdmittedHostRuntime Runtime { get; }
    internal RuntimeSupervisor Supervisor { get; }

    /// <summary>
    /// A non-null refusal is written to the file the fixture reads before it answers the handshake,
    /// so the child writes those exact bytes to its own standard error and exits without an
    /// acknowledgement. A status plan is the exact frame plan the child writes before its
    /// acknowledgement. A silence timeout overrides the launcher's interval so a test observes the
    /// watch expire in milliseconds.
    /// </summary>
    internal static async Task<BootstrapHandshakeHarness> CreateAsync(string? refusal = null, string? statusPlan = null, TimeSpan? silenceTimeout = null)
    {
        var generation = await DisposableInstalledGuardianGeneration.BuildAsync();
        try
        {
            generation.ReplaceHostRuntimeWithFixture();
            var registration = new CurrentUserRootRegistrationRecord(CurrentUserRootRegistration.SchemaVersion, generation.ProgramRoot);
            var operationalRoot = Path.Combine(generation.LocalApplicationData, "GameBuddy", "operational");
            foreach (var path in new[] { Path.Combine(generation.LocalApplicationData, "GameBuddy", "data"), operationalRoot, Path.Combine(generation.LocalApplicationData, "GameBuddy", "presentation") }) Directory.CreateDirectory(path);
            TestDeploymentManifest.WriteDeploymentManifest(operationalRoot);
            var layout = CurrentUserRootLayout.DeriveForTesting(registration, new LocalApplicationDataProvider(generation.LocalApplicationData));
            var selection = InstalledGenerationSelection.Acquire(generation.ProgramRoot);
            try
            {
                var runtime = new InstalledHostRuntimeAdmission().Admit(selection);
                if (refusal is not null) File.WriteAllBytes(Path.Combine(layout.DataRoot, "desktop-host-runtime-fixture.refuse"), Encoding.UTF8.GetBytes(refusal));
                if (statusPlan is not null) File.WriteAllText(Path.Combine(layout.DataRoot, "desktop-host-runtime-fixture.status.json"), statusPlan, new UTF8Encoding(false));
                var supervisor = new RuntimeSupervisor { BootstrapSilenceTimeoutForTesting = silenceTimeout };
                return new BootstrapHandshakeHarness(generation, layout, selection, runtime, supervisor);
            }
            catch
            {
                await selection.DisposeAsync().ConfigureAwait(false);
                throw;
            }
        }
        catch
        {
            await generation.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>
    /// The frame plan the fixture child writes verbatim, in order, before its acknowledgement: the
    /// delay after each frame, the quiet stretch before the acknowledgement, and whether it writes
    /// that acknowledgement at all.
    /// </summary>
    internal static string StatusPlan(IEnumerable<string> frames, int delayMs = 0, int holdMs = 0, bool acknowledgement = true) =>
        JsonSerializer.Serialize(new { frames = frames.ToArray(), delayMs, holdMs, ack = acknowledgement });

    internal void RequestHostExit() => File.WriteAllText(Path.Combine(Layout.DataRoot, "desktop-host-runtime-fixture.ready.exit"), "exit");

    public async ValueTask DisposeAsync()
    {
        await Supervisor.DisposeAsync();
        await Runtime.DisposeAsync();
        await Selection.DisposeAsync();
        await Generation.DisposeAsync();
    }

    private sealed class LocalApplicationDataProvider(string path) : ILocalApplicationDataProvider
    {
        public string GetLocalApplicationDataPath() => path;
    }
}
