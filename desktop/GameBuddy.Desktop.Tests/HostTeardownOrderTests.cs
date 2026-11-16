using System.Diagnostics;
using System.Text.Json;
using GameBuddy.Desktop.Tests.Fixtures;
using Xunit.Sdk;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// Pins the ORDER of a clean quit: the launcher gives the child its controller EOF, waits for the
/// child's own reclamation, and terminates only as the watchdog over that wait.
///
/// The stand-in child is the fixture, on the real anonymous pipes and the real authenticated broker.
/// It is what makes the difference observable: it runs the production Host's eight named reclamation
/// steps when, and only when, its owner closes the session, so a launcher that terminates first
/// leaves no journal at all.
/// </summary>
public sealed class HostTeardownOrderTests
{
    private static readonly TimeSpan Silence = TimeSpan.FromSeconds(30);

    /// <summary>
    /// The production Host's frozen reclamation table, in its order. A launcher test that names its
    /// own steps could not tell "the child reclaimed" from "the child reclaimed the way I hoped".
    /// </summary>
    private static readonly string[] ReclamationSteps =
    [
        "stop_admission",
        "drain_chat_runtime",
        "drain_game_lifecycle",
        "reflect_session",
        "release_shared_authority",
        "release_guardian_session",
        "release_voice_client",
        "release_termination_watchers",
    ];

    /// <summary>
    /// The quit the player asks for: the lease is disposed without the child having been asked to
    /// leave, so everything the child does from here is caused by the launcher's own teardown.
    /// </summary>
    [Fact]
    public async Task A_quit_gives_the_host_its_controller_eof_and_its_reclamation_runs()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(silenceTimeout: Silence);
        await using var lease = await harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None);
        Assert.False(File.Exists(harness.ReclamationJournalPath));

        var elapsed = Stopwatch.StartNew();
        await lease.DisposeAsync();
        elapsed.Stop();

        // The child ran its own reclamation, which it only does once its owner closed the session.
        Assert.Equal(ReclamationSteps, await File.ReadAllLinesAsync(harness.ReclamationJournalPath));
        // And this child ended itself: the launcher never had to reach for the watchdog, so it left
        // no teardown fact behind.
        Assert.Empty(TeardownRecords(harness));
        // The wait was the child's exit, not a timeout: it is two orders of magnitude inside the
        // deadline the child itself published (8 x 60 s).
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(30), $"the quit waited {elapsed.Elapsed}");
    }

    /// <summary>
    /// A reclamation that names a failed step is the child's own fact and reaches the child's own
    /// diagnostic - in the directory and the shape an operator already reads. The launcher neither
    /// invents that record nor rewrites the step it names.
    /// </summary>
    [Fact]
    public async Task A_reclamation_that_names_a_failed_step_leaves_the_hosts_own_record()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            reclamationPlan: """{ "fail": "drain_chat_runtime" }""",
            silenceTimeout: Silence);
        await using var lease = await harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None);

        await lease.DisposeAsync();

        Assert.Equal(ReclamationSteps, await File.ReadAllLinesAsync(harness.ReclamationJournalPath));
        var record = Assert.Single(Directory.GetFiles(harness.HostExitRecordDirectory, "host-exit-*.json"));
        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(record));
        var root = document.RootElement;
        Assert.Equal("gamebuddy-desktop-host-exit-record/v1", root.GetProperty("schema").GetString());
        Assert.Equal("incomplete_exit", root.GetProperty("kind").GetString());
        Assert.Equal("desktop_host_child_will_not_stop", root.GetProperty("reason").GetString());
        var steps = root.GetProperty("steps").EnumerateArray().ToArray();
        Assert.Equal(ReclamationSteps, steps.Select(step => step.GetProperty("step").GetString()!));
        var failed = Assert.Single(steps, step => step.GetProperty("status").GetString() == "failed");
        Assert.Equal("drain_chat_runtime", failed.GetProperty("step").GetString());
        Assert.Empty(TeardownRecords(harness));
    }

    /// <summary>
    /// The watchdog: a child that ignores its controller EOF is terminated at the deadline it
    /// published, and the launcher records that fact under its own name with what it waited and
    /// what the child reported before it. This is the case that used to leave nothing behind.
    /// </summary>
    [Fact]
    public async Task A_host_that_ignores_its_controller_eof_is_terminated_at_the_published_deadline_and_named()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            // A real Host publishes 8 x its per-step budget; the stand-in publishes a value a test
            // can wait out, which is the only difference between this run and the real one.
            acknowledgementPlan: """{ "rewrite": { "drainDeadlineMs": 400 } }""",
            reclamationPlan: """{ "ignoreEof": true }""",
            silenceTimeout: Silence);
        await using var lease = await harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None);

        var elapsed = Stopwatch.StartNew();
        await lease.DisposeAsync();
        elapsed.Stop();

        Assert.True(elapsed.Elapsed >= TimeSpan.FromMilliseconds(400), $"the quit did not wait the published deadline: {elapsed.Elapsed}");
        // The child never ran a step, because it never accepted that it was leaving.
        Assert.False(File.Exists(harness.ReclamationJournalPath));
        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(Assert.Single(TeardownRecords(harness))));
        var root = document.RootElement;
        Assert.Equal("gamebuddy-desktop-host-teardown/v1", root.GetProperty("schema").GetString());
        Assert.Equal("host_teardown_timeout", root.GetProperty("outcome").GetString());
        Assert.Equal(400, root.GetProperty("drainDeadlineMs").GetInt64());
        Assert.True(root.GetProperty("elapsedMs").GetInt64() >= 400);
        // Nothing was reported on this path: the child was still alive when the wait expired, so it
        // had written neither steps nor a record of its own.
        Assert.Empty(root.GetProperty("steps").EnumerateArray());
    }

    /// <summary>
    /// A child that ended by itself is not waited for: the launcher closes the session, sees the
    /// process already gone and finishes, leaving no teardown fact.
    /// </summary>
    [Fact]
    public async Task A_host_that_already_ended_is_not_waited_for()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(silenceTimeout: Silence);
        await using var lease = await harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None);
        harness.RequestHostExit();
        Assert.True(await lease.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)));

        var elapsed = Stopwatch.StartNew();
        await lease.DisposeAsync();
        elapsed.Stop();

        Assert.Empty(TeardownRecords(harness));
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(5), $"the quit waited {elapsed.Elapsed}");
    }

    /// <summary>
    /// A kill also carries what the child managed to say about itself: a child that wrote its own
    /// record and then never left is reported with the steps it named, so the launcher's fact and the
    /// child's fact can be read side by side instead of the launcher's kill erasing the other one.
    /// </summary>
    [Fact]
    public async Task A_kill_carries_the_steps_the_host_had_already_reported()
    {
        if (!OperatingSystem.IsWindows()) throw SkipException.ForSkip("Requires Windows.");
        await using var harness = await BootstrapHandshakeHarness.CreateAsync(
            acknowledgementPlan: """{ "rewrite": { "drainDeadlineMs": 400 } }""",
            reclamationPlan: """{ "fail": "drain_chat_runtime", "holdMs": 600000 }""",
            silenceTimeout: Silence);
        await using var lease = await harness.Supervisor.StartHostAsync(harness.Selection, harness.Runtime, harness.Layout, CancellationToken.None);

        await lease.DisposeAsync();

        // The child did reclaim and did write its own record; it simply never left.
        Assert.Equal(ReclamationSteps, await File.ReadAllLinesAsync(harness.ReclamationJournalPath));
        Assert.Single(Directory.GetFiles(harness.HostExitRecordDirectory, "host-exit-*.json"));
        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(Assert.Single(TeardownRecords(harness))));
        var root = document.RootElement;
        Assert.Equal("host_teardown_timeout", root.GetProperty("outcome").GetString());
        var reported = root.GetProperty("steps").EnumerateArray().ToArray();
        Assert.Equal(ReclamationSteps, reported.Select(step => step.GetProperty("step").GetString()!));
        var failed = Assert.Single(reported, step => step.GetProperty("status").GetString() == "failed");
        Assert.Equal("drain_chat_runtime", failed.GetProperty("step").GetString());
        Assert.Equal("desktop_host_child_will_not_stop", failed.GetProperty("failure").GetString());
    }

    private static string[] TeardownRecords(BootstrapHandshakeHarness harness) =>
        Directory.Exists(harness.HostExitRecordDirectory)
            ? Directory.GetFiles(harness.HostExitRecordDirectory, "host-teardown-*.json")
            : [];
}
