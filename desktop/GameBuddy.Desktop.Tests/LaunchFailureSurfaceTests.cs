using System.Text.Json;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// A launch that fails during Host composition has to be TOLD: a window the player can read, a
/// sentence naming what stopped, and a record on disk beside the one an operator already reads.
///
/// The measured failure this covers produced none of the three: the Host child threw
/// `semantic_chat_liveness_unrecoverable` while provisioning, the launcher rethrew it as
/// `guardian_launch_unavailable:host_runtime_unavailable`, and the entry wrote one stderr line and
/// returned - no tray (it only starts after the acknowledgement), no dialog, no record.
/// </summary>
public sealed class LaunchFailureSurfaceTests
{
    private const string CompositionFailureCode = "semantic_chat_liveness_unrecoverable";
    private const string ChildCategory = "host_runtime_unavailable";
    private const string AnnouncedStage = "provisioning";
    private const string StatusSchema = "gamebuddy-desktop-host-bootstrap-status/v1";

    private readonly ITestOutputHelper output;

    public LaunchFailureSurfaceTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void A_composition_failure_is_told_and_recorded()
    {
        var operationalRoot = ScratchOperationalRoot();

        var notice = Program.Record(
            DesktopLaunchResult.GuardianLaunchUnavailable,
            ChildCategory,
            AnnouncedStage,
            CompositionFailureCode,
            operationalRoot);

        // The record: the schema and the directory an operator already reads, with the child's own
        // code and the step it was at.
        var path = Assert.Single(Directory.GetFiles(Path.Combine(operationalRoot, "host-exit"), "host-exit-*.json"));
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var root = document.RootElement;
        Assert.Equal("gamebuddy-desktop-host-exit-record/v1", root.GetProperty("schema").GetString());
        Assert.Equal(1, root.GetProperty("version").GetInt32());
        Assert.Equal("crash", root.GetProperty("kind").GetString());
        Assert.Equal(CompositionFailureCode, root.GetProperty("reason").GetString());
        Assert.Equal(Environment.ProcessId, root.GetProperty("pid").GetInt32());
        Assert.True(root.GetProperty("recordedAtUnixMs").GetInt64() > 0);
        var step = Assert.Single(root.GetProperty("steps").EnumerateArray().ToArray());
        Assert.Equal(AnnouncedStage, step.GetProperty("step").GetString());
        Assert.Equal("failed", step.GetProperty("status").GetString());
        Assert.Equal(CompositionFailureCode, step.GetProperty("failure").GetString());

        // The copy: what stopped, what the Host itself said, what the player can do, and where the
        // record is. The child named the cause this launch's own result cannot - a Chat root with no
        // conversation to open - so the sentence names that instead of sending the player back to the
        // same refusal.
        Assert.Equal("GameBuddy could not start", LaunchFailureNotice.Title);
        var body = LaunchFailureWindow.BodyText(notice);
        Assert.Contains("no conversation it can open", body, StringComparison.Ordinal);
        Assert.Contains($"\"{AnnouncedStage}\"", body, StringComparison.Ordinal);
        Assert.Contains(CompositionFailureCode, body, StringComparison.Ordinal);
        Assert.DoesNotContain("Start GameBuddy again", body, StringComparison.Ordinal);
        Assert.Contains("Send the report below to support", body, StringComparison.Ordinal);
        Assert.Contains(path, body, StringComparison.Ordinal);
        Assert.Equal(path, notice.RecordPath);

        output.WriteLine($"record {path}:");
        output.WriteLine(File.ReadAllText(path).TrimEnd());
        output.WriteLine("window body:");
        output.WriteLine(body);
    }

    [Fact]
    public void A_failure_that_named_no_code_still_says_what_stopped_and_what_to_do()
    {
        var notice = Program.Record(
            DesktopLaunchResult.GuardianLaunchUnavailable,
            ChildCategory,
            stage: null,
            childCode: null,
            operationalRoot: ScratchOperationalRoot());

        Assert.Null(notice.ReportedCode);
        var body = LaunchFailureWindow.BodyText(notice);
        Assert.Contains("background service stopped before it was ready", body, StringComparison.Ordinal);
        Assert.Contains("Start GameBuddy again", body, StringComparison.Ordinal);
        Assert.DoesNotContain("It reported", body, StringComparison.Ordinal);
    }

    [Fact]
    public void A_record_that_cannot_be_written_is_never_a_second_failure_of_the_launch()
    {
        var notice = Program.Record(
            DesktopLaunchResult.GuardianLaunchUnavailable,
            ChildCategory,
            AnnouncedStage,
            CompositionFailureCode,
            operationalRoot: null);

        Assert.Null(notice.RecordPath);
        Assert.DoesNotContain("Report:", LaunchFailureWindow.BodyText(notice), StringComparison.Ordinal);
    }

    [Fact]
    public void A_child_code_is_carried_only_when_it_is_one_bounded_code()
    {
        var direct = Program.Record(
            DesktopLaunchResult.GuardianLaunchUnavailable,
            ChildCategory,
            AnnouncedStage,
            CompositionFailureCode,
            operationalRoot: null);
        Assert.Equal(CompositionFailureCode, direct.ReportedCode);

        // Anything that is not already one bounded lowercase code is not quoted as if it were: the
        // window carries a code the Host emitted, never a child's prose or a path.
        var prose = Program.Record(
            DesktopLaunchResult.GuardianLaunchUnavailable,
            ChildCategory,
            AnnouncedStage,
            "Error: something went wrong at C:\\Users\\player\\GameBuddy",
            operationalRoot: null);
        Assert.Null(prose.ReportedCode);
    }

    /// <summary>
    /// The measured failure, forced through the REAL launcher against a REAL child: the child refuses
    /// with the exact bytes the composition's own refusal printed, the launcher captures them, and the
    /// player's window and the record name them.
    /// </summary>
    [Fact]
    public async Task A_real_child_refusing_with_the_measured_code_is_told_and_recorded()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(refusal: CompositionFailureCode);

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        // The two structured facts the visible surface reads, taken from the child itself.
        Assert.Equal(ChildCategory, failure.Category);
        Assert.Equal(CompositionFailureCode, failure.ChildStderr);
        Assert.Equal(
            "guardian_launch_unavailable:host_runtime_unavailable " + failure.Diagnostic,
            Program.OutcomeCode(DesktopLaunchResult.GuardianLaunchUnavailable, failure.Category, failure.Diagnostic));

        var notice = Program.Record(
            DesktopLaunchResult.GuardianLaunchUnavailable,
            failure.Category,
            failure.BootstrapStage,
            failure.ChildStderr,
            harness.Layout.OperationalRoot);

        var path = Assert.Single(Directory.GetFiles(harness.HostExitRecordDirectory, "host-exit-*.json"));
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var root = document.RootElement;
        Assert.Equal("gamebuddy-desktop-host-exit-record/v1", root.GetProperty("schema").GetString());
        Assert.Equal(CompositionFailureCode, root.GetProperty("reason").GetString());
        var step = Assert.Single(root.GetProperty("steps").EnumerateArray().ToArray());
        Assert.Equal(CompositionFailureCode, step.GetProperty("failure").GetString());

        var body = LaunchFailureWindow.BodyText(notice);
        Assert.Contains(CompositionFailureCode, body, StringComparison.Ordinal);
        Assert.Contains(path, body, StringComparison.Ordinal);

        output.WriteLine($"record {path}:");
        output.WriteLine(File.ReadAllText(path).TrimEnd());
        output.WriteLine("window body:");
        output.WriteLine(body);
    }

    /// <summary>
    /// The other half of the same failure: the production child announces `provisioning` and then
    /// throws, so the step is part of what the player is told. This drives a real child that announces
    /// that stage and then offers no acknowledgement at all, which is the launcher's own reading of
    /// "it stopped here".
    /// </summary>
    [Fact]
    public async Task A_real_child_that_announced_provisioning_names_that_step()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            statusPlan: BootstrapHandshakeHarness.StatusPlan([Status(AnnouncedStage)], holdMs: 60_000),
            // The watch is what ends this launch, so it has to be far shorter than the wait - but long
            // enough that a loaded machine still delivers the frame the child announced first.
            silenceTimeout: TimeSpan.FromSeconds(3));

        var failure = await Assert.ThrowsAsync<GuardianLaunchUnavailableException>(
            () => harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None));

        Assert.Equal(RuntimeSupervisor.BootstrapTimeoutCategory, failure.Category);
        Assert.Equal(AnnouncedStage, failure.BootstrapStage);

        var notice = Program.Record(
            DesktopLaunchResult.GuardianLaunchUnavailable,
            failure.Category,
            failure.BootstrapStage,
            failure.ChildStderr,
            harness.Layout.OperationalRoot);
        Assert.Contains($"\"{AnnouncedStage}\"", LaunchFailureWindow.BodyText(notice), StringComparison.Ordinal);

        using var document = JsonDocument.Parse(File.ReadAllText(
            Assert.Single(Directory.GetFiles(harness.HostExitRecordDirectory, "host-exit-*.json"))));
        var step = Assert.Single(document.RootElement.GetProperty("steps").EnumerateArray().ToArray());
        Assert.Equal(AnnouncedStage, step.GetProperty("step").GetString());
    }

    [Fact]
    public void The_window_the_player_sees_carries_the_sentence()
    {
        var notice = Program.Record(
            DesktopLaunchResult.GuardianLaunchUnavailable,
            ChildCategory,
            AnnouncedStage,
            CompositionFailureCode,
            operationalRoot: null);

        var rendered = RunOnStaThread(() =>
        {
            using var window = new LaunchFailureWindow(notice);
            return (window.Text, window.RenderedBody, window.CloseLabel);
        });

        Assert.Equal(LaunchFailureNotice.Title, rendered.Text);
        Assert.Equal(LaunchFailureWindow.BodyText(notice), rendered.RenderedBody);
        Assert.Contains(CompositionFailureCode, rendered.RenderedBody, StringComparison.Ordinal);
        Assert.Equal("Close", rendered.CloseLabel);
    }

    [Fact]
    public void A_failed_launch_is_told_to_the_player_before_the_entry_returns_non_zero()
    {
        var source = File.ReadAllText(DesktopProgramSource());
        var main = source[source.IndexOf("private static async Task<int> Main(string[] args)", StringComparison.Ordinal)..source.IndexOf("/// <summary>\n    /// Downloads the newer release", StringComparison.Ordinal)];

        var recorded = main.IndexOf("Record(outcome.Result", StringComparison.Ordinal);
        var told = main.IndexOf("LaunchFailureWindow.Show(", StringComparison.Ordinal);
        var exit = main.LastIndexOf("return 1;", StringComparison.Ordinal);
        Assert.True(recorded >= 0, "the entry never records a failed launch for the player or an operator");
        Assert.True(told >= 0, "the entry never shows the player what failed");
        Assert.True(exit > recorded && exit > told, "the entry returns before the player can read what failed");
        // The window shows the record's own statement: one statement, so the window cannot name a code
        // the record does not carry.
        Assert.Contains("Record(", main[told..], StringComparison.Ordinal);
    }

    /// <summary>
    /// Both Chat root refusals, one test: the two codes say which fact is missing (a conversation to
    /// open, or the list itself) and neither offers the retry that was measured to return the same
    /// answer. What they do name is the record, because that record is the only thing that carries the
    /// conversation list this launch could not open.
    /// </summary>
    [Theory]
    [InlineData("semantic_chat_liveness_unrecoverable", "no conversation it can open")]
    [InlineData("semantic_chat_liveness_unreadable", "could not read this installation's list of conversations")]
    public void A_chat_root_refusal_names_what_is_missing_and_not_a_retry(string code, string sentence)
    {
        var notice = Program.Record(
            DesktopLaunchResult.GuardianLaunchUnavailable,
            ChildCategory,
            stage: null,
            childCode: code,
            operationalRoot: null);

        Assert.Equal(code, notice.ReportedCode);
        var body = LaunchFailureWindow.BodyText(notice);
        Assert.Contains(sentence, body, StringComparison.Ordinal);
        Assert.Contains(code, body, StringComparison.Ordinal);
        Assert.DoesNotContain("Start GameBuddy again", body, StringComparison.Ordinal);
        Assert.Contains("Send the report below to support", body, StringComparison.Ordinal);
    }

    /// <summary>One well-formed status frame, exactly as the child's own writer emits it.</summary>
    private static string Status(string stage) =>
        JsonSerializer.Serialize(new Dictionary<string, object> { ["schema"] = StatusSchema, ["protocolVersion"] = 1, ["stage"] = stage });

    private static string ScratchOperationalRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "gamebuddy-launch-failure-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        return root;
    }

    private static T RunOnStaThread<T>(Func<T> body)
    {
        T value = default!;
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { value = body(); }
            catch (Exception exception) { failure = exception; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) throw new InvalidOperationException("the failure window could not be created", failure);
        return value;
    }

    private static string DesktopProgramSource() =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "Program.cs"));
}
