using System.Diagnostics;
using System.Text;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// Guards that the launcher can report why the Host child refused its private
/// bootstrap: the child's own stderr is captured, bounded, redacted, and attached to
/// the launch failure beside the codes that were already there, and neither the
/// capture nor its absence changes what a launch does.
/// </summary>
public sealed class ChildStderrDiagnosticTests
{
    [Fact]
    public void The_excerpt_is_one_bounded_line_with_every_credential_shape_removed()
    {
        var rendered = ChildStderrExcerpt.Render(Encoding.UTF8.GetBytes(string.Join('\n',
            "host refused: deployment manifest rejected",
            "CPA_OAI_API_KEY=cpaoai-ABCDEF0123456789abcdef",
            "Authorization: Bearer sk-live-8f2b1c9d4e5a6b7c8d9e0f1a2b3c4d5e",
            "token: \"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.Zm9vYmFyYmF6cXV4",
            "installRoot C:\\Users\\someone\\AppData\\Local\\Programs\\GameBuddy")));

        // The refusal survives: the operator reads the fact, not a blank line.
        Assert.Contains("host refused: deployment manifest rejected", rendered, StringComparison.Ordinal);
        Assert.Contains("installRoot C:\\Users\\someone\\AppData\\Local\\Programs\\GameBuddy", rendered, StringComparison.Ordinal);
        // One line only: the launcher's channel carries one bounded document.
        Assert.DoesNotContain('\n', rendered);
        Assert.DoesNotContain('\r', rendered);
        // Every credential value is gone, by name, by scheme, and by generated shape.
        Assert.DoesNotContain("cpaoai-ABCDEF0123456789abcdef", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("sk-live-8f2b1c9d4e5a6b7c8d9e0f1a2b3c4d5e", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("eyJhbGciOiJIUzI1NiJ9", rendered, StringComparison.Ordinal);
        Assert.Contains("<redacted>", rendered, StringComparison.Ordinal);
        Assert.True(rendered.Length <= 512 + 3, $"excerpt was not capped: {rendered.Length}");
    }

    [Fact]
    public void A_long_generated_run_is_redacted_even_without_a_credential_shaped_name()
    {
        // An opaque run the child printed with no label at all still goes: a 64-char
        // lowercase hexadecimal digest and a mixed-case base64 body are both values a
        // searcher for a secret must not find on the operator channel.
        var rendered = ChildStderrExcerpt.Render(Encoding.UTF8.GetBytes(
            "binding mismatch sha256 5ff02a392f1d2f253750f958dc5e72a1c26cfdeb0046870d5563127c41f7da69 and body 8f2b1c9d4E5a6B7c8D9e0F1a2B3c4D5e+"));

        Assert.Contains("binding mismatch sha256", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("5ff02a392f1d2f253750f958dc5e72a1c26cfdeb0046870d5563127c41f7da69", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("8f2b1c9d4E5a6B7c8D9e0F1a2B3c4D5e+", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void An_empty_capture_is_reported_as_a_capture_that_found_nothing()
    {
        // The two facts are different and only one is known: the capture retained no
        // bytes. Saying the child was silent would be a claim the launcher cannot make.
        Assert.Equal(string.Empty, ChildStderrExcerpt.Render(Array.Empty<byte>()));
        Assert.Equal("host_child_stderr: (captured nothing)", ChildStderrExcerpt.Format(string.Empty));
        Assert.DoesNotContain("said nothing", ChildStderrExcerpt.NothingCaptured, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void The_operator_line_keeps_both_codes_and_appends_the_childs_own_words_last()
    {
        Assert.Equal(
            "guardian_launch_unavailable:host_runtime_unavailable host_child_stderr: host refused: manifest rejected",
            Program.OutcomeCode(DesktopLaunchResult.GuardianLaunchUnavailable, "host_runtime_unavailable", "host_child_stderr: host refused: manifest rejected"));
        // A launch that never created a child appends nothing at all, and a reason that
        // is not a bounded code is still withheld.
        Assert.Equal("guardian_launch_unavailable", Program.OutcomeCode(DesktopLaunchResult.GuardianLaunchUnavailable));
        Assert.Equal(
            "guardian_launch_unavailable host_child_stderr: (captured nothing)",
            Program.OutcomeCode(DesktopLaunchResult.GuardianLaunchUnavailable, "GuardianLaunchUnavailable", ChildStderrExcerpt.NothingCaptured));
    }

    [Fact]
    public async Task A_refused_handshake_reports_what_the_child_wrote_to_its_own_stderr()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await RefusalHarness.CreateAsync("host refused: the deployment manifest declares an unsupported schemaVersion");

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        // The primary code and the appended category are exactly what they were.
        Assert.Equal("host_runtime_unavailable", failure.Category);
        Assert.NotNull(failure.Diagnostic);
        Assert.StartsWith(ChildStderrExcerpt.Label, failure.Diagnostic!, StringComparison.Ordinal);
        Assert.Contains("the deployment manifest declares an unsupported schemaVersion", failure.Diagnostic!, StringComparison.Ordinal);
        // And the line the operator finally sees carries all three facts.
        Assert.Equal(
            "guardian_launch_unavailable:host_runtime_unavailable " + failure.Diagnostic,
            Program.OutcomeCode(DesktopLaunchResult.GuardianLaunchUnavailable, failure.Category, failure.Diagnostic));
    }

    [Fact]
    public async Task A_refused_handshake_redacts_a_credential_the_child_printed()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        const string secret = "cpaoai-9F3bC1dE5aB7c9D0e2F4a6B8c0D2e4F6";
        await using var harness = await RefusalHarness.CreateAsync($"provider refused: CPA_OAI_API_KEY={secret} rejected");

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        Assert.NotNull(failure.Diagnostic);
        Assert.Contains("provider refused", failure.Diagnostic!, StringComparison.Ordinal);
        Assert.DoesNotContain(secret, failure.Diagnostic!, StringComparison.Ordinal);
        Assert.Contains("<redacted>", failure.Diagnostic!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_child_that_writes_nothing_is_reported_as_a_capture_that_found_nothing()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await RefusalHarness.CreateAsync(string.Empty);

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        Assert.Equal("host_runtime_unavailable", failure.Category);
        Assert.Equal("host_child_stderr: (captured nothing)", failure.Diagnostic);
    }

    [Fact]
    public async Task A_child_that_floods_its_stderr_is_still_drained_and_the_launch_is_not_delayed_to_the_bootstrap_timeout()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        // Far past any pipe buffer: a capture that stopped consuming would fill the
        // pipe and park the child on its next write, so the observation would change
        // the launch it observes. Draining is what makes this fail fast instead of
        // waiting out the 30-second bootstrap timeout.
        await using var harness = await RefusalHarness.CreateAsync(new string('x', 200_000) + " refusal-tail");

        var stopwatch = Stopwatch.StartNew();
        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));
        stopwatch.Stop();

        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(20), $"the launch took {stopwatch.Elapsed} - the child was blocked on a full stderr pipe");
        Assert.NotNull(failure.Diagnostic);
        Assert.DoesNotContain("(captured nothing)", failure.Diagnostic!, StringComparison.Ordinal);
        // The retained excerpt is the child's own first bytes, capped, not the flood.
        Assert.True(failure.Diagnostic!.Length <= ChildStderrExcerpt.Label.Length + 1 + 512 + 3, $"excerpt was not capped: {failure.Diagnostic!.Length}");
    }

    [Fact]
    public async Task A_launch_that_succeeds_is_unaffected_by_the_stderr_capture()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await RefusalHarness.CreateAsync(refusal: null);

        await using var lease = await harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None);

        // The success path is untouched: the lease is live and the child reached its
        // own steady state exactly as it did before the capture existed.
        Assert.True(File.Exists(Path.Combine(harness.Layout.DataRoot, "desktop-host-runtime-fixture.ready")));
        harness.RequestHostExit();
        Assert.True(await lease.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));
    }

    /// <summary>
    /// One installed generation whose replacement Host runtime is the test fixture,
    /// with the manifest the launcher's pre-launch check requires. A non-null refusal
    /// is written to the file the fixture reads before it answers the handshake, so
    /// the child writes those exact bytes to its own stderr and exits without an
    /// acknowledgement.
    /// </summary>
    private sealed class RefusalHarness : IAsyncDisposable
    {
        private RefusalHarness(DisposableInstalledGuardianGeneration generation, CurrentUserRootLayout layout, InstalledGenerationSelection selection, AdmittedHostRuntime runtime, RuntimeSupervisor supervisor)
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

        internal static async Task<RefusalHarness> CreateAsync(string? refusal)
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
                    return new RefusalHarness(generation, layout, selection, runtime, new RuntimeSupervisor());
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

        internal void RequestHostExit() => File.WriteAllText(Path.Combine(Layout.DataRoot, "desktop-host-runtime-fixture.ready.exit"), "exit");

        public async ValueTask DisposeAsync()
        {
            await Supervisor.DisposeAsync();
            await Runtime.DisposeAsync();
            await Selection.DisposeAsync();
            await Generation.DisposeAsync();
        }
    }

    private sealed class LocalApplicationDataProvider(string path) : ILocalApplicationDataProvider
    {
        public string GetLocalApplicationDataPath() => path;
    }
}
