using System.Diagnostics;
using System.Text.RegularExpressions;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The gate over "a quit waits for a process".
///
/// The defect this exists for: the native Guardian's exit was awaited with a ceiling of the launcher's
/// own (30 s) BEFORE the measured wait on the Host child began, so a quit cost the player the Guardian's
/// exit AND the deadline the child published, counted separately - and the number the launcher recorded
/// described only the second half. The property is not "the Guardian is fast": it is that the whole quit
/// is bounded by ONE declared number and that the measurement covers every wait it performed.
///
/// <para>
/// The population is every process-wait call site in the launcher's own sources, found by scanning the
/// directory rather than by naming files, so a wait added tomorrow is in the population without anyone
/// remembering this gate. Each site's bound is classified from the expression that supplies it:
/// a <c>budget</c> expression (cannot outlast the quit's declared number), a <c>declared</c> name (a
/// constant or a value the caller supplied), a <c>probe</c> of 0 (spends no time), or a bare
/// <c>literal</c>. A literal is a number nobody declared: it is outside the budget by construction and
/// the gate fails naming the site and the milliseconds it could add.
/// </para>
/// </summary>
public sealed class ShutdownWaitBudgetTests
{
    private static readonly Regex NumericLiteral = new(@"^\d[\d_]*$", RegexOptions.CultureInvariant);
    private static readonly Regex DeclaredName = new(@"^[A-Za-z_][A-Za-z0-9_.]*$", RegexOptions.CultureInvariant);
    private static readonly string[] WaitCalls = ["WaitForSingleObject", "WaitForExitWithinAsync", "CloseControlAndWaitForExitAsync"];

    [Fact]
    public void Every_process_wait_in_the_launcher_declares_the_bound_it_may_spend()
    {
        var sites = EnumerateWaitSites().ToArray();
        var budget = sites.Count(site => site.Kind == "budget");
        var declared = sites.Count(site => site.Kind == "declared");
        var probes = sites.Count(site => site.Kind == "probe");
        var outside = sites.Where(site => site.Kind is "literal" or "unclassified").ToArray();

        Assert.True(sites.Length > 0, "waits examined 0 · the scan found no process wait at all, so it proves nothing");
        Assert.True(
            outside.Length == 0,
            $"waits examined {sites.Length} · inside budget {budget} · declared {declared} · probes {probes} · outside {outside.Length}"
            + string.Concat(outside.Select(site => $"\n  {site.Where}: '{site.Bound}' can spend {site.Milliseconds} ms that no declared budget covers")));
    }

    /// <summary>
    /// The quit's shape, one budget deep. Every claim here names the number that would have to change,
    /// and the behavioural half of this property is
    /// <c>HostTeardownOrderTests.The_quit_spends_one_declared_deadline_across_the_guardian_and_the_host_child</c>.
    /// </summary>
    [Fact]
    public void The_quit_spends_one_declared_budget_and_records_what_it_spent()
    {
        var supervisor = File.ReadAllText(LauncherSource("RuntimeSupervisor.cs"));
        var broker = File.ReadAllText(LauncherSource("DesktopHostBootstrapBroker.cs"));

        // One budget, and it is the child's own published exit deadline - the launcher keeps no copy.
        Assert.Contains("var budget = new ShutdownBudget(Result.DrainDeadlineMs);", supervisor, StringComparison.Ordinal);
        // It is created before the arm, and the arm is what performs the Guardian's exit wait: the
        // budget is handed to the broker close, so the Guardian's wait is inside the measured window.
        Assert.Contains("await closingBroker.CloseAsync(budget, cancellationToken)", supervisor, StringComparison.Ordinal);
        // The Guardian's wait draws its ceiling from that budget and never from a number of its own.
        Assert.Contains("budget.Take(GuardianSupervisorLease.ContainmentCeilingMs)", broker, StringComparison.Ordinal);
        // The child's wait and the last-resort wait after the kill share what is left, so a process that
        // will not even die adds no time the declared deadline does not cover.
        Assert.Equal(2, Occurrences(supervisor, "WaitForExitWithinAsync(child, budget.RemainingMs)"));
        // The teardown fact carries what the quit spent against what was declared: the wait the player
        // experienced, not a fragment of it.
        Assert.Contains("DesktopHostTeardownRecord.Write(operationalRoot, pid, budget.ConsumedMs, budget.DeclaredMs)", supervisor, StringComparison.Ordinal);
        // No close path may wait for the Guardian with a bound of its own.
        Assert.DoesNotContain("CloseControlAndWaitForExitAsync(CancellationToken.None)", broker, StringComparison.Ordinal);
    }

    /// <summary>
    /// Right-BICEP on the budget itself: the boundary is exhaustion, the invariant is that the sum of
    /// what waits may spend never exceeds the declared number, and the measurement is that sum.
    /// </summary>
    [Fact]
    public void A_budget_never_lets_a_later_wait_extend_an_earlier_one()
    {
        var budget = new ShutdownBudget(600);
        var spent = Stopwatch.StartNew();

        Thread.Sleep(150);
        var afterFirstWait = budget.RemainingMs;
        Assert.True(afterFirstWait <= 600 - 130, $"150 ms spent left {afterFirstWait} ms of a 600 ms budget");
        // A ceiling larger than what is left is clamped to what is left, never to the ceiling.
        Assert.True(budget.Take(30_000) <= afterFirstWait, $"Take(30_000) returned {budget.Take(30_000)} with {afterFirstWait} ms left");
        Assert.True(budget.ConsumedMs >= spent.ElapsedMilliseconds - 5, "the measurement does not cover the wait that already happened");

        Thread.Sleep(600);
        Assert.Equal(0, budget.RemainingMs);
        Assert.Equal(0u, budget.Take(30_000));
        Assert.Equal(600, budget.DeclaredMs);
    }

    private static int Occurrences(string source, string value)
    {
        var count = 0;
        for (var index = source.IndexOf(value, StringComparison.Ordinal); index >= 0; index = source.IndexOf(value, index + value.Length, StringComparison.Ordinal)) count++;
        return count;
    }

    private static IEnumerable<WaitSite> EnumerateWaitSites()
    {
        foreach (var path in Directory.EnumerateFiles(LauncherDirectory(), "*.cs", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(LauncherDirectory(), path).Replace('\\', '/');
            // Generated sources under obj/ and the published tree under bin/ are not the launcher's own
            // declarations, and a wait that only exists in a build output cannot be reviewed.
            if (relative.StartsWith("obj/", StringComparison.Ordinal) || relative.StartsWith("bin/", StringComparison.Ordinal)) continue;
            var lines = File.ReadAllLines(path);
            for (var index = 0; index < lines.Length; index++)
            {
                var line = lines[index];
                if (line.Contains(" extern ", StringComparison.Ordinal)) continue;
                var trimmed = line.TrimStart();
                if (trimmed.StartsWith("internal ", StringComparison.Ordinal) || trimmed.StartsWith("private ", StringComparison.Ordinal) ||
                    trimmed.StartsWith("public ", StringComparison.Ordinal) || trimmed.StartsWith("protected ", StringComparison.Ordinal)) continue;
                foreach (var call in WaitCalls)
                {
                    var at = line.IndexOf(call + "(", StringComparison.Ordinal);
                    if (at < 0) continue;
                    var arguments = Arguments(line, at + call.Length + 1);
                    if (arguments.Count < 2) continue;
                    // The bound is the last argument of a wait on a handle, and the first of the two
                    // calls whose name already says what it waits for.
                    var bound = (call == "CloseControlAndWaitForExitAsync" ? arguments[0] : arguments[^1]).Trim();
                    var (kind, milliseconds) = Classify(bound);
                    yield return new WaitSite($"{relative}:{index + 1}", bound, kind, milliseconds);
                }
            }
        }
    }

    private static List<string> Arguments(string line, int start)
    {
        var arguments = new List<string>();
        var depth = 0;
        var current = new System.Text.StringBuilder();
        for (var index = start; index < line.Length; index++)
        {
            var character = line[index];
            if (character == '(') depth++;
            else if (character == ')')
            {
                if (depth == 0) break;
                depth--;
            }
            else if (character == ',' && depth == 0)
            {
                arguments.Add(current.ToString());
                current.Clear();
                continue;
            }
            current.Append(character);
        }
        arguments.Add(current.ToString());
        return arguments;
    }

    private static (string Kind, long Milliseconds) Classify(string bound)
    {
        if (bound.StartsWith("budget.", StringComparison.Ordinal)) return ("budget", 0);
        if (NumericLiteral.IsMatch(bound))
        {
            var milliseconds = long.Parse(bound.Replace("_", string.Empty, StringComparison.Ordinal));
            return (milliseconds == 0 ? "probe" : "literal", milliseconds);
        }
        if (DeclaredName.IsMatch(bound)) return ("declared", 0);
        return ("unclassified", 0);
    }

    private static string LauncherSource(string file) => Path.Combine(LauncherDirectory(), file);

    private static string LauncherDirectory() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop"));

    private readonly record struct WaitSite(string Where, string Bound, string Kind, long Milliseconds);
}
