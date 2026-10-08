using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The Desktop shell's own entry surface: the private handoff pipe the admitted Host child
/// publishes its presentation entry on, the one browser open that follows, and the tray and
/// app-instance behaviour that owns reopening and quitting.
///
/// The failure each test catches is stated on the test itself. The positive handoff cases use a
/// real Node client on a real named pipe, because the production child is Node and the whole
/// point of this channel is that Node can use it without the launcher owning Node's private IPC
/// bootstrap.
/// </summary>
public sealed class PresentationShellTests
{
    private const string Token = "fixture-bootstrap-token-0123456789";
    private const string Entry = $"http://127.0.0.1:41234/#profile=composed-reference-game&boot={Token}";
    private static readonly string BootstrapId = new string('0', 32) + new string('1', 32);

    /// <summary>
    /// The launcher reads the child's entry over the private pipe and only from the exact child.
    /// Catches: a handoff that is never delivered (the shipped defect this work exists for), a
    /// frame whose key order or shape the two ends disagree about, and an outcome that carries
    /// the entry in a field it may not travel in.
    /// </summary>
    [Fact]
    public async Task Presentation_entry_travels_over_the_private_pipe_from_the_exact_admitted_child()
    {
        using var workspace = new TestWorkspace();
        await using var handoff = DesktopPresentationHandoff.Create(BootstrapId);
        var framePath = workspace.WriteFrame($"{{\"schema\":\"{DesktopPresentationHandoff.FrameSchema}\",\"protocolVersion\":1,\"bootstrapId\":\"{BootstrapId}\",\"launchUrl\":\"{Entry}\"}}");
        using var child = StartNodeClient(workspace.ClientScriptPath, DesktopPresentationHandoff.PipePath(BootstrapId), framePath);

        var outcome = await handoff.ReadEntryAsync(ChildHandle(child), TimeSpan.FromSeconds(20), CancellationToken.None);

        Assert.True(outcome.Category == DesktopPresentationHandoffOutcome.Accepted,
            $"category={outcome.Category} child_stderr={ChildStderr(child)}");
        Assert.NotNull(outcome.LaunchUrl);
        Assert.Equal(Entry, outcome.LaunchUrl!.AbsoluteUri);
        // The category is what the launcher records and shows; it is a fixed token and can never
        // be the place the entry leaks.
        Assert.DoesNotContain(Token, outcome.Category, StringComparison.Ordinal);
        Assert.DoesNotContain("boot=", outcome.Category, StringComparison.Ordinal);
    }

    /// <summary>
    /// A client that is not the admitted child is refused without its frame being read.
    /// Catches: any same-user process spending this launch's one handoff, and a validation that
    /// compares something weaker than the platform's own client process id.
    /// </summary>
    [Fact]
    public async Task The_handoff_refuses_a_client_that_is_not_the_exact_admitted_child()
    {
        using var workspace = new TestWorkspace();
        await using var handoff = DesktopPresentationHandoff.Create(BootstrapId);
        var framePath = workspace.WriteFrame($"{{\"schema\":\"{DesktopPresentationHandoff.FrameSchema}\",\"protocolVersion\":1,\"bootstrapId\":\"{BootstrapId}\",\"launchUrl\":\"{Entry}\"}}");
        // The admitted child is this sleeping Node process. The frame below is written by the
        // test process, which is a client this launch never admitted.
        using var child = StartNodeProcess(workspace.IdleScriptPath, []);

        var read = handoff.ReadEntryAsync(ChildHandle(child), TimeSpan.FromSeconds(20), CancellationToken.None);
        await WriteRawFrameAsync(DesktopPresentationHandoff.PipeName(BootstrapId), File.ReadAllText(framePath) + "\n");
        var outcome = await read;

        Assert.Equal(DesktopPresentationHandoffOutcome.ClientRefused, outcome.Category);
        Assert.Null(outcome.LaunchUrl);
    }

    /// <summary>
    /// A child that never connects produces "no presentation" after a bounded wait instead of
    /// hanging the launcher. Catches: a launch that waits forever for an optional fact, which is
    /// exactly the shape of "installs, starts, and then nothing happens".
    /// </summary>
    [Fact]
    public async Task The_handoff_reports_absence_instead_of_hanging_when_the_child_never_connects()
    {
        using var workspace = new TestWorkspace();
        await using var handoff = DesktopPresentationHandoff.Create(BootstrapId);
        using var child = StartNodeProcess(workspace.IdleScriptPath, []);
        var started = Stopwatch.StartNew();

        var outcome = await handoff.ReadEntryAsync(ChildHandle(child), TimeSpan.FromMilliseconds(400), CancellationToken.None);

        Assert.Equal(DesktopPresentationHandoffOutcome.Absent, outcome.Category);
        Assert.Null(outcome.LaunchUrl);
        Assert.True(started.Elapsed < TimeSpan.FromSeconds(20), $"the bounded wait took {started.Elapsed}");
    }

    /// <summary>
    /// Every frame that is not exactly this channel's one shape is refused, even when it comes
    /// from the exact admitted child. Catches: a wrong schema, an extra field a second process
    /// might smuggle in, a frame for another launch's bootstrap id, and an entry that is not the
    /// literal loopback origin this product serves.
    /// </summary>
    [Theory]
    [InlineData("gamebuddy-desktop-presentation-handoff/v2")]
    [InlineData("gamebuddy-desktop-host-bootstrap/v1")]
    public async Task The_handoff_refuses_a_frame_with_another_schema(string schema)
    {
        await AssertFrameRefusedAsync(
            $"{{\"schema\":\"{schema}\",\"protocolVersion\":1,\"bootstrapId\":\"{BootstrapId}\",\"launchUrl\":\"{Entry}\"}}");
    }

    [Fact]
    public async Task The_handoff_refuses_a_frame_with_an_extra_field()
    {
        // A secondary process may not turn this one-shot channel into an option channel: a valid
        // frame with one more field is refused, not accepted with the field ignored.
        await AssertFrameRefusedAsync(
            $"{{\"schema\":\"{DesktopPresentationHandoff.FrameSchema}\",\"protocolVersion\":1,\"bootstrapId\":\"{BootstrapId}\",\"launchUrl\":\"{Entry}\",\"root\":\"C:\\\\data\"}}");
    }

    [Fact]
    public async Task The_handoff_refuses_a_frame_for_another_launch()
    {
        await AssertFrameRefusedAsync(
            $"{{\"schema\":\"{DesktopPresentationHandoff.FrameSchema}\",\"protocolVersion\":1,\"bootstrapId\":\"{new string('a', 64)}\",\"launchUrl\":\"{Entry}\"}}");
    }

    [Theory]
    [InlineData("http://example.com/#profile=composed-reference-game&boot=fixture-bootstrap-token-0123456789")]
    [InlineData("https://127.0.0.1:41234/#boot=fixture-bootstrap-token-0123456789")]
    [InlineData("http://127.0.0.1/#boot=fixture-bootstrap-token-0123456789")]
    public async Task The_handoff_refuses_an_entry_that_is_not_the_loopback_origin(string entry)
    {
        await AssertFrameRefusedAsync(
            $"{{\"schema\":\"{DesktopPresentationHandoff.FrameSchema}\",\"protocolVersion\":1,\"bootstrapId\":\"{BootstrapId}\",\"launchUrl\":\"{entry}\"}}");
    }

    /// <summary>
    /// The automatic open happens once and only after the handoff has delivered an entry, and a
    /// browser that cannot start is a missing presentation rather than a failed session.
    /// Catches: a second automatic open (a second belief about a one-time admission) and a
    /// launch that dies because the player's shell has no handler.
    /// </summary>
    [Fact]
    public void The_entry_is_opened_exactly_once_by_the_automatic_path_and_never_by_a_broken_browser()
    {
        var opened = new List<Uri>();
        var presenter = DesktopBrowserPresenter.CreateForTesting(url =>
        {
            opened.Add(url);
            return true;
        });
        Assert.False(presenter.OpenOnce());
        presenter.Adopt(new Uri(Entry));
        Assert.True(presenter.OpenOnce());
        Assert.False(presenter.OpenOnce());
        Assert.Equal(1, presenter.OpenCount);
        // The tray's Open is the player asking again, which is a different act and may repeat.
        Assert.True(presenter.Open());
        Assert.Equal(2, opened.Count);
        Assert.Equal(DesktopBrowserPresenter.OpenedCategory, presenter.ResultCategory());

        var unavailable = DesktopBrowserPresenter.CreateForTesting(_ => throw new InvalidOperationException("no handler"));
        unavailable.Adopt(new Uri(Entry));
        Assert.False(unavailable.OpenOnce());
        Assert.Equal(0, unavailable.OpenCount);
        Assert.Equal(DesktopBrowserPresenter.UnavailableCategory, unavailable.ResultCategory());

        var withoutEntry = DesktopBrowserPresenter.CreateForTesting(_ => true);
        Assert.False(withoutEntry.OpenOnce());
        Assert.Equal(DesktopBrowserPresenter.NotAdoptedCategory, withoutEntry.ResultCategory());
    }

    /// <summary>
    /// The dev browser hook exists in a launch only when a launch says so, and it says so with one
    /// exact token. Catches: a GAMEBUDDY_DESKTOP_BROWSER_COMMAND left in a developer's or a
    /// player's environment taking the entry over, a flag spelling that is treated as "close
    /// enough" ("0", "true", "yes", an empty value, or "1" with anything around it), and a
    /// command that is consulted before the flag decided - a variable that is only read where it
    /// can never matter is the same as one that is never read.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("true")]
    [InlineData("yes")]
    [InlineData(" 1")]
    [InlineData("1 ")]
    public void The_dev_browser_hook_is_ignored_unless_the_enable_flag_is_exactly_one(string? flag)
    {
        var opened = new List<Uri>();
        var association = new Func<Uri, bool>(url => { opened.Add(url); return true; });
        var environment = new EnvironmentProbe(flag, NominatedProgramFixture());

        var choice = DesktopDevBrowserHook.Choose(environment.ReadName, association);

        // The player's own association, untouched, and the nominated command not even read.
        Assert.Same(association, choice.Opener);
        Assert.Equal(DesktopBrowserPresenter.UnavailableCategory, choice.FailureCategory);
        Assert.DoesNotContain(environment.ReadNames, name => name == DesktopDevBrowserHook.CommandVariable);

        var presenter = DesktopBrowserPresenter.CreateForTesting(environment.ReadName, association);
        presenter.Adopt(new Uri(Entry));
        Assert.True(presenter.OpenOnce());
        Assert.Equal(new[] { Entry }, opened.Select(url => url.AbsoluteUri));
        Assert.Equal(1, presenter.OpenCount);
        Assert.Equal(DesktopBrowserPresenter.OpenedCategory, presenter.ResultCategory());
    }

    [Fact]
    public void The_dev_browser_hook_names_the_variables_and_the_bounded_category_it_reports()
    {
        // The two names are the whole operator contract of this affordance, and the category is
        // what a launch that could not hand the entry over says instead of a reason that would
        // have to carry the entry.
        Assert.Equal("GAMEBUDDY_DEV_BROWSER_HOOK", DesktopDevBrowserHook.EnableVariable);
        Assert.Equal("GAMEBUDDY_DESKTOP_BROWSER_COMMAND", DesktopDevBrowserHook.CommandVariable);
        Assert.Equal("1", DesktopDevBrowserHook.EnableValue);
        Assert.Equal("presentation_dev_browser_unavailable", DesktopDevBrowserHook.UnavailableCategory);
        Assert.NotEqual(DesktopBrowserPresenter.UnavailableCategory, DesktopDevBrowserHook.UnavailableCategory);
    }

    /// <summary>
    /// An enabled hook with no program named runs nothing and does not fall back to the player's
    /// association. Catches: a silent fallback, which would spend this launch's one-time admission
    /// on exactly the undrivable browser the affordance exists to remove, and a refusal that takes
    /// the launch (or the admitted Host session behind it) down with it.
    ///
    /// (The brief this work came from asked for "the hook is ignored" in this case as well. It
    /// cannot be: an ignored hook takes the association path, and the requirement for an enabled
    /// hook with nothing named - as for one whose program cannot start - is this bounded category.
    /// The flag is an explicit statement of intent, so it is honoured rather than second-guessed.)
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void An_enabled_dev_browser_hook_without_a_named_program_runs_nothing_and_reports_its_own_category(string? command)
    {
        var opened = new List<Uri>();
        var association = new Func<Uri, bool>(url => { opened.Add(url); return true; });
        var environment = new EnvironmentProbe("1", command);

        var choice = DesktopDevBrowserHook.Choose(environment.ReadName, association);
        Assert.NotSame(association, choice.Opener);
        Assert.Equal(DesktopDevBrowserHook.UnavailableCategory, choice.FailureCategory);
        Assert.False(choice.Opener(new Uri(Entry)));

        var presenter = DesktopBrowserPresenter.CreateForTesting(environment.ReadName, association);
        presenter.Adopt(new Uri(Entry));
        Assert.False(presenter.OpenOnce());
        Assert.Empty(opened);
        Assert.Equal(0, presenter.OpenCount);
        Assert.Equal(DesktopDevBrowserHook.UnavailableCategory, presenter.ResultCategory());
        // The launch is still alive and still answerable: the entry stays adopted, and the tray's
        // Open is answered with the same bounded category rather than an exception.
        Assert.True(presenter.HasEntry);
        Assert.False(presenter.Open());
        Assert.Equal(DesktopDevBrowserHook.UnavailableCategory, presenter.ResultCategory());
    }

    /// <summary>
    /// With both variables set, the nominated program - a real executable image - is started
    /// exactly once by the automatic path and receives the entry as its only argument. Catches: an
    /// entry that is split, quoted, decorated or handed over through a command line, an automatic
    /// open that happens twice, and an association that is consulted even though the launch asked
    /// for a nominated program.
    /// </summary>
    [Fact]
    public async Task The_nominated_program_is_started_once_with_the_entry_as_its_only_argument()
    {
        var report = ResetNominatedProgramReport();
        var environment = new EnvironmentProbe("1", NominatedProgramFixture());
        var presenter = DesktopBrowserPresenter.CreateForTesting(
            environment.ReadName,
            _ => throw new InvalidOperationException("a launch with an enabled hook must not consult the player's association"));
        presenter.Adopt(new Uri(Entry));

        Assert.True(presenter.OpenOnce());
        await WaitFor(() => ReadNominatedProgramInvocations(report).Length == 1);
        // The automatic open is still once per launch: the second ask starts nothing.
        Assert.False(presenter.OpenOnce());
        Assert.Equal(1, presenter.OpenCount);
        Assert.Equal(DesktopBrowserPresenter.OpenedCategory, presenter.ResultCategory());

        var invocations = ReadNominatedProgramInvocations(report);
        Assert.Single(invocations);
        Assert.Equal(new[] { Entry }, invocations[0]);
    }

    /// <summary>
    /// A nominated program that cannot be started is a missing presentation and never a failed
    /// session: the launch reports one bounded category, opens nothing else, throws nothing, and
    /// keeps answering. Catches: an unhandled exception out of the launcher's one new process
    /// start, which would end a healthy Host session over a broken development affordance.
    /// </summary>
    [Fact]
    public void A_nominated_program_that_cannot_start_leaves_the_launch_alive_and_reports_the_bounded_category()
    {
        var missing = Path.Combine(Path.GetTempPath(), "gb-dev-browser-missing-" + Guid.NewGuid().ToString("N"), "not-a-program.exe");
        var opened = new List<Uri>();
        var environment = new EnvironmentProbe("1", missing);
        var presenter = DesktopBrowserPresenter.CreateForTesting(
            environment.ReadName,
            url => { opened.Add(url); return true; });
        presenter.Adopt(new Uri(Entry));

        Assert.False(presenter.OpenOnce());
        Assert.Equal(0, presenter.OpenCount);
        Assert.Equal(DesktopDevBrowserHook.UnavailableCategory, presenter.ResultCategory());
        // Nothing was opened as a second choice, and nothing was created on the way.
        Assert.Empty(opened);
        Assert.False(Directory.Exists(Path.GetDirectoryName(missing)));
        // The launch keeps working after the refusal.
        Assert.False(presenter.Open());
        Assert.Equal(DesktopDevBrowserHook.UnavailableCategory, presenter.ResultCategory());
    }

    /// <summary>
    /// The hook's own source is where the entry could leak or be split, so it is pinned: the entry
    /// is formatted exactly once and only into the single argv element of a directly started
    /// program, no shell is involved, the failure path adds no message that could carry the entry,
    /// and the launch reaches the hook only through its own environment and its own association.
    /// Catches: a concatenated command line, a shell (which reads the entry's '&' as a command
    /// separator and would split the boot token), a diagnostic that echoes the entry, and a
    /// presenter that stops consulting the hook at all.
    /// </summary>
    [Fact]
    public void The_dev_browser_hook_formats_the_entry_once_and_cannot_convey_it_anywhere_else()
    {
        var source = File.ReadAllText(Path.Combine(DesktopProjectRoot(), "DesktopDevBrowserHook.cs"));

        Assert.Equal(1, CountOccurrences(source, "AbsoluteUri"));
        Assert.Contains("start.ArgumentList.Add(entry.AbsoluteUri);", source, StringComparison.Ordinal);
        Assert.Contains("UseShellExecute = false", source, StringComparison.Ordinal);
        Assert.DoesNotContain("UseShellExecute = true", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Arguments = ", source, StringComparison.Ordinal);
        Assert.DoesNotContain("cmd.exe", source, StringComparison.Ordinal);
        Assert.DoesNotContain("powershell", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("string.Concat", source, StringComparison.Ordinal);
        Assert.DoesNotContain("+ \" ", source, StringComparison.Ordinal);

        var presenter = File.ReadAllText(Path.Combine(DesktopProjectRoot(), "DesktopBrowserPresenter.cs"));
        Assert.Contains("DesktopDevBrowserHook.Choose(Environment.GetEnvironmentVariable, OpenWithShell)", presenter, StringComparison.Ordinal);
    }

    /// <summary>
    /// The handoff and its presenter have no channel that could carry the entry anywhere but the
    /// pipe and the shell's own association call. Catches: a diagnostic, a log line, a debug
    /// trace, an exception message or a file write that would put a live one-shot credential
    /// somewhere a file or a reader can reach.
    /// </summary>
    [Fact]
    public void The_handoff_source_has_no_console_log_debug_or_file_channel()
    {
        foreach (var file in new[] { "DesktopPresentationHandoff.cs", "DesktopBrowserPresenter.cs", "DesktopDevBrowserHook.cs" })
        {
            var source = File.ReadAllText(Path.Combine(DesktopProjectRoot(), file));
            foreach (var forbidden in new[] { "Console.", "WriteLine", "File.", "Directory.", "Trace.", "Debug.", "EventLog", "Log(", "Message =" })
                Assert.DoesNotContain(forbidden, source, StringComparison.Ordinal);
        }
        var handoff = File.ReadAllText(Path.Combine(DesktopProjectRoot(), "DesktopPresentationHandoff.cs"));
        Assert.Contains("GetNamedPipeClientProcessId", handoff, StringComparison.Ordinal);
        Assert.Contains("PipeOptions.CurrentUserOnly", handoff, StringComparison.Ordinal);
        // The entry leaves this file through exactly one object - the parsed Uri in the outcome -
        // so it is neither formatted into a string nor concatenated onto one.
        Assert.Contains("internal readonly record struct DesktopPresentationHandoffOutcome(Uri? LaunchUrl, string Category)", handoff, StringComparison.Ordinal);
        Assert.DoesNotContain("ToString()", handoff, StringComparison.Ordinal);
    }

    /// <summary>
    /// The shell's vocabulary is closed and typed, and Hide states this adapter's truth instead
    /// of pretending to hide a window the shell does not own. Catches: a generic command bridge
    /// arriving as "one more intent", a hide that silently stops nothing but claims to, and a
    /// quit that closes more than once.
    /// </summary>
    [Fact]
    public void Shell_intents_are_typed_and_a_hide_never_fabricates_a_hidden_window()
    {
        var opens = 0;
        var quits = 0;
        var router = new ShellIntentRouter(() => { opens += 1; return true; }, () => { quits += 1; return true; });

        var open = router.Dispatch(ShellIntent.Open);
        Assert.Equal(ShellIntentRouter.OpenAccepted, open.Category);
        Assert.Equal(1, opens);

        var hide = router.Dispatch(ShellIntent.Hide);
        Assert.Equal(ShellIntentRouter.WindowNotOwned, hide.Category);
        Assert.Contains(ShellIntentRouter.ProductSurfaceLabel, router.StatusText, StringComparison.Ordinal);
        Assert.Equal(1, opens);
        Assert.Equal(0, quits);

        var quit = router.Dispatch(ShellIntent.Quit);
        Assert.Equal(ShellIntentRouter.QuitRequested, quit.Category);
        Assert.Equal(1, quits);
        Assert.Equal(ShellIntentRouter.QuitRequested, router.Dispatch(ShellIntent.Quit).Category);
        Assert.Equal(1, quits);
        // One quit closes once: the second ask is answered with the same outcome and never
        // reaches the close path a second time.
        Assert.Equal(1, router.QuitCount);

        var unavailable = new ShellIntentRouter(() => false, () => false);
        Assert.Equal(ShellIntentRouter.OpenUnavailable, unavailable.Dispatch(ShellIntent.Open).Category);
        Assert.Equal(ShellIntentRouter.QuitUnavailable, unavailable.Dispatch(ShellIntent.Quit).Category);
    }

    /// <summary>
    /// The installed copy names the surface the way the design requires and offers only its own
    /// three intents. Catches: the development label ("Browser Preview") or a future WebView2
    /// claim reaching the player, and the tray growing a way to run something of its own.
    /// </summary>
    [Fact]
    public void The_tray_copy_names_the_installed_surface_and_offers_only_its_three_intents()
    {
        var source = File.ReadAllText(Path.Combine(DesktopProjectRoot(), "TrayShell.cs"));

        Assert.Contains("Open GameBuddy", source, StringComparison.Ordinal);
        Assert.Contains("Hide GameBuddy", source, StringComparison.Ordinal);
        Assert.Contains("Quit GameBuddy", source, StringComparison.Ordinal);
        Assert.Contains("Desktop Browser Presentation", source, StringComparison.Ordinal);
        Assert.Contains("ShellIntent.Open", source, StringComparison.Ordinal);
        Assert.Contains("ShellIntent.Hide", source, StringComparison.Ordinal);
        Assert.Contains("ShellIntent.Quit", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Browser Preview", source, StringComparison.Ordinal);
        Assert.DoesNotContain("WebView2", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Process.Start", source, StringComparison.Ordinal);
        Assert.DoesNotContain("string command", source, StringComparison.Ordinal);
        // The tray's tooltip is bounded by the platform's own limit rather than truncated onto
        // the floor when a status sentence is long.
        Assert.Equal(63, TrayShell.TooltipFor(new string('x', 200)).Length);
    }

    /// <summary>
    /// A secondary invocation's channel carries exactly two intents and refuses everything else.
    /// Catches: a second process smuggling an option, a root or a command through the app-instance
    /// channel, and a refusal that silently disappears by being dispatched anyway.
    /// </summary>
    [Fact]
    public async Task The_primary_intent_pipe_delivers_open_and_focus_and_refuses_every_other_frame()
    {
        var delivered = new List<PrimaryIntent>();
        using var stopping = new CancellationTokenSource();
        await using var pipe = PrimaryIntentPipe.Start(intent =>
        {
            lock (delivered) delivered.Add(intent);
        }, stopping.Token);

        Assert.True(await AppInstanceOwner.RequestOpenAsync(CancellationToken.None));
        await WaitFor(() => Count(delivered) == 1);
        Assert.Equal(new[] { PrimaryIntent.Open }, Snapshot(delivered));

        // A frame with one more field is refused. The next DELIVERED intent is the valid focus
        // frame written after it, so this cannot pass by the refusal never being processed.
        await WriteRawFrameAsync(PrimaryIntentPipe.PipeName,
            $"{{\"schema\":\"{PrimaryIntentPipe.FrameSchema}\",\"protocolVersion\":1,\"intent\":\"open\",\"root\":\"C:\\\\data\"}}\n");
        await WriteRawFrameAsync(PrimaryIntentPipe.PipeName,
            $"{{\"schema\":\"{PrimaryIntentPipe.FrameSchema}\",\"protocolVersion\":1,\"intent\":\"focus\"}}\n");
        await WaitFor(() => Count(delivered) == 2);
        Assert.Equal(new[] { PrimaryIntent.Open, PrimaryIntent.Focus }, Snapshot(delivered));

        // An intent outside the vocabulary is refused, and again the proof is that the frame
        // after it is the next one delivered.
        await WriteRawFrameAsync(PrimaryIntentPipe.PipeName,
            $"{{\"schema\":\"{PrimaryIntentPipe.FrameSchema}\",\"protocolVersion\":1,\"intent\":\"quit\"}}\n");
        await WriteRawFrameAsync(PrimaryIntentPipe.PipeName,
            $"{{\"schema\":\"{PrimaryIntentPipe.FrameSchema}\",\"protocolVersion\":1,\"intent\":\"open\"}}\n");
        await WaitFor(() => Count(delivered) == 3);
        Assert.Equal(new[] { PrimaryIntent.Open, PrimaryIntent.Focus, PrimaryIntent.Open }, Snapshot(delivered));

        stopping.Cancel();
    }

    /// <summary>
    /// One primary instance per partition, and a partition is a bounded closed token.
    /// Catches: a double launch producing two Host owners, an installed and a portable partition
    /// colliding on one lease name, and a caller addressing another product's instance by passing
    /// a longer or differently punctuated name.
    /// </summary>
    [Fact]
    public void The_app_instance_lease_admits_one_primary_per_partition_and_separates_partitions()
    {
        var partition = "test-" + Guid.NewGuid().ToString("N")[..12];
        using var primary = AppInstanceOwner.Acquire(partition);
        Assert.True(primary.IsPrimary);

        // Another holder - here another thread, in production another process - is not primary.
        var secondaryIsPrimary = true;
        var thread = new Thread(() =>
        {
            using var second = AppInstanceOwner.Acquire(partition);
            secondaryIsPrimary = second.IsPrimary;
        });
        thread.Start();
        thread.Join();
        Assert.False(secondaryIsPrimary);

        Assert.NotEqual(AppInstanceOwner.LeaseName("installed"), AppInstanceOwner.LeaseName("portable-qa"));
        foreach (var refused in new[] { "", "Installed", "../data", "installed$", new string('a', 33) })
            Assert.Throws<ArgumentException>(() => AppInstanceOwner.LeaseName(refused));
    }

    /// <summary>
    /// The entry is opened only after the child has acknowledged, and only the exact child's frame
    /// is trusted. Catches: a launcher that opens a browser for a launch that never reached
    /// readiness, and one that reads the entry from a channel any process could write.
    /// </summary>
    [Fact]
    public void The_supervisor_reads_the_entry_after_the_acknowledgement_and_only_from_the_child()
    {
        var source = File.ReadAllText(Path.Combine(DesktopProjectRoot(), "RuntimeSupervisor.cs"));

        var create = source.IndexOf("handoff = DesktopPresentationHandoff.Create(bootstrapId);", StringComparison.Ordinal);
        var spawn = source.IndexOf("WindowsNative.CreateProcess(runtimePath, commandLine", StringComparison.Ordinal);
        var acknowledge = source.IndexOf("var ack = await ReadAcknowledgementAsync(", StringComparison.Ordinal);
        var read = source.IndexOf("await handoff.ReadEntryAsync(process,", StringComparison.Ordinal);
        var open = source.IndexOf("_ = Presentation.OpenOnce();", StringComparison.Ordinal);

        Assert.True(create >= 0 && spawn > create, "the pipe must exist before the child is created");
        Assert.True(acknowledge > spawn && read > acknowledge, "the entry is read only after the acknowledgement");
        Assert.True(open > read, "the browser is opened only after the entry was read");
        // The entry is opened exactly once per launch, and a browser that cannot start cannot end
        // the session: the open is best-effort and its result is deliberately not a failure.
        Assert.Contains("DesktopBrowserPresenter Presentation { get; init; } = new();", source, StringComparison.Ordinal);
        Assert.Contains("if (presentation.LaunchUrl is not null)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("throw new GuardianLaunchUnavailableException(presentation", source, StringComparison.Ordinal);
    }

    private async Task AssertFrameRefusedAsync(string frame)
    {
        using var workspace = new TestWorkspace();
        await using var handoff = DesktopPresentationHandoff.Create(BootstrapId);
        var framePath = workspace.WriteFrame(frame);
        using var child = StartNodeClient(workspace.ClientScriptPath, DesktopPresentationHandoff.PipePath(BootstrapId), framePath);

        var outcome = await handoff.ReadEntryAsync(ChildHandle(child), TimeSpan.FromSeconds(20), CancellationToken.None);

        Assert.True(outcome.Category == DesktopPresentationHandoffOutcome.FrameRefused,
            $"category={outcome.Category} child_stderr={ChildStderr(child)}");
        Assert.Null(outcome.LaunchUrl);
    }

    private static int Count(List<PrimaryIntent> delivered)
    {
        lock (delivered) return delivered.Count;
    }

    private static PrimaryIntent[] Snapshot(List<PrimaryIntent> delivered)
    {
        lock (delivered) return [.. delivered];
    }

    private static async Task WaitFor(Func<bool> condition)
    {
        for (var attempt = 0; attempt < 200 && !condition(); attempt += 1)
            await Task.Delay(25);
        Assert.True(condition(), "the intent channel did not deliver the expected intent in time");
    }

    private static WindowsNative.SafeProcessHandle ChildHandle(Process child)
    {
        // The handle is deliberately not owned here: the Process object owns the real handle, and
        // the launcher only reads the child's process id through it.
        return new WindowsNative.SafeProcessHandle(child.Handle);
    }

    /// <summary>
    /// What the client fixture said about not connecting. It is included in a failure so a broken
    /// client reports itself instead of looking exactly like a handoff that never arrived.
    /// </summary>
    private static string ChildStderr(Process child)
    {
        try
        {
            if (!child.WaitForExit(500)) child.Kill(entireProcessTree: true);
            if (!child.WaitForExit(5_000)) return "(child did not exit)";
            return child.StandardError.ReadToEnd().Trim();
        }
        catch (Exception exception) when (exception is InvalidOperationException or SystemException)
        {
            return $"(child stderr unavailable: {exception.GetType().Name})";
        }
    }

    private static Process StartNodeClient(string scriptPath, string pipeName, string framePath) =>
        StartNodeProcess(scriptPath, [pipeName, framePath]);

    private static Process StartNodeProcess(string scriptPath, string[] arguments)
    {
        var start = new ProcessStartInfo(NodeExecutable())
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
        };
        foreach (var argument in new[] { scriptPath }.Concat(arguments)) start.ArgumentList.Add(argument);
        return Process.Start(start) ?? throw new InvalidOperationException("Could not start the Node client fixture.");
    }

    private static async Task WriteRawFrameAsync(string pipeName, string frame)
    {
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.Asynchronous);
        await client.ConnectAsync(5_000);
        var bytes = Encoding.UTF8.GetBytes(frame);
        await client.WriteAsync(bytes);
        await client.FlushAsync();
    }

    private static string NodeExecutable()
    {
        var node = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        return File.Exists(node) ? node : throw new InvalidOperationException("test_publisher_node_unavailable");
    }

    /// <summary>
    /// The nominated program of the dev browser hook, as this test project builds it: a real
    /// executable image that records the arguments it was started with. It is the only account of
    /// the handover that does not come from the launcher itself.
    /// </summary>
    private static string NominatedProgramFixture()
    {
        var directory = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "Fixtures", "DevBrowserNominatedProgramFixture"));
        var candidates = Directory.Exists(directory)
            ? Directory.EnumerateFiles(directory, "DevBrowserNominatedProgramFixture.exe", SearchOption.AllDirectories)
                .OrderBy(path => path.Length)
                .ToArray()
            : [];
        Assert.True(candidates.Length > 0, $"The nominated-program fixture was not built under {directory}.");
        return candidates[0];
    }

    private static string ResetNominatedProgramReport()
    {
        var report = Path.Combine(Path.GetDirectoryName(NominatedProgramFixture())!, "nominated-program-invocation.jsonl");
        if (File.Exists(report)) File.Delete(report);
        return report;
    }

    /// <summary>One entry per invocation, in the order the nominated program was started.</summary>
    private static string[][] ReadNominatedProgramInvocations(string report)
    {
        if (!File.Exists(report)) return [];
        // The nominated program appends to this file, and it may still hold its handle while the
        // test looks: a reader that demands exclusive access would turn this proof into a race.
        string[] lines;
        using (var stream = new FileStream(report, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (var reader = new StreamReader(stream))
        {
            lines = reader.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        }

        var invocations = new List<string[]>();
        foreach (var line in lines)
        {
            if (!line.StartsWith('[')) continue;
            try
            {
                if (JsonSerializer.Deserialize<string[]>(line) is { } invocation) invocations.Add(invocation);
            }
            catch (JsonException)
            {
                // A line that is not yet a whole record is not an invocation.
            }
        }

        return [.. invocations];
    }

    private static int CountOccurrences(string text, string token)
    {
        var count = 0;
        for (var index = text.IndexOf(token, StringComparison.Ordinal); index >= 0;
             index = text.IndexOf(token, index + token.Length, StringComparison.Ordinal)) count += 1;
        return count;
    }

    /// <summary>
    /// A launch's environment as the hook reads it, plus the names it was actually asked for: a
    /// variable that is only read where it can never matter counts as one that was not read.
    /// </summary>
    private sealed class EnvironmentProbe(string? flag, string? command)
    {
        private readonly List<string> read = [];

        internal IReadOnlyList<string> ReadNames
        {
            get { lock (read) return [.. read]; }
        }

        internal string? ReadName(string name)
        {
            lock (read) read.Add(name);
            return name switch
            {
                DesktopDevBrowserHook.EnableVariable => flag,
                DesktopDevBrowserHook.CommandVariable => command,
                _ => null,
            };
        }
    }

    private static string DesktopProjectRoot() =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop"));

    /// <summary>
    /// A disposable directory for one test's client script and frame file. The frame is test input
    /// written by the test itself; nothing in the launcher may write one.
    /// </summary>
    private sealed class TestWorkspace : IDisposable
    {
        private readonly string root;

        internal TestWorkspace()
        {
            root = Path.Combine(Path.GetTempPath(), "gb-presentation-shell-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            Id = Guid.NewGuid().ToString("N");
            ClientScriptPath = Path.Combine(root, "handoff-client.mjs");
            IdleScriptPath = Path.Combine(root, "idle.mjs");
            File.WriteAllText(ClientScriptPath, string.Join('\n',
                "import { readFileSync } from \"node:fs\";",
                "import { connect } from \"node:net\";",
                "const [pipeName, framePath] = process.argv.slice(2);",
                "const frame = readFileSync(framePath);",
                "const socket = connect(pipeName);",
                "socket.on(\"connect\", () => socket.end(frame));",
                "socket.on(\"error\", (error) => { process.stderr.write(\"client_error:\" + error.message + \"\\n\"); process.exitCode = 1; });",
                "socket.on(\"close\", () => process.exit(process.exitCode ?? 0));",
                "setTimeout(() => process.exit(2), 20000);"), new UTF8Encoding(false));
            File.WriteAllText(IdleScriptPath, "setTimeout(() => process.exit(0), 60000);\n", new UTF8Encoding(false));
        }

        internal string Id { get; }
        internal string ClientScriptPath { get; }
        internal string IdleScriptPath { get; }

        internal string WriteFrame(string frame)
        {
            var path = Path.Combine(root, $"frame-{Guid.NewGuid():N}.json");
            File.WriteAllText(path, frame + "\n", new UTF8Encoding(false));
            return path;
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }
}
