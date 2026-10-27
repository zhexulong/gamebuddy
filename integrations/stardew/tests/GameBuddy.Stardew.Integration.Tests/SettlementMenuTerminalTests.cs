using System;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Who owns the settlement menu AFTER the lifecycle finishes.
///
/// `541775c2` taught the lifecycle to commit a shipping summary it meets while waiting for the sleep prompt. That
/// covers the menu the night itself raises. It does not cover the menu still standing when the lifecycle hands the
/// actor back, and measured on the 2026-10-26 run that is exactly what happened:
///
///     `advance_day` reached `day_advanced` and succeeded - the milestone chain reads day4@1200, day4@1800,
///     day4@2200, day5@0600 - and the companion then could not move, because a ShippingMenu was still up. Its own
///     words, at elapsed 910015ms: the settlement sheet is still in front of me, I cannot do anything, I cannot even
///     move. Thirty-seven submissions came back `quarantined`.
///
/// The structure behind it: `Phase.AwaitingModal` was the ONLY place that recognised a settlement menu, and
/// `UpdateActiveDayAdvance` drops the lifecycle handle the moment it finishes, so from the next tick nothing in the
/// product looked at that modal again. Its last owner had left.
///
/// These cases pin the obligation at the TERMINAL, which is the only place an owner can discharge it before letting go.
/// </summary>
public sealed class SettlementMenuTerminalTests
{
    // Internal to the Mod assembly, so it is reached by reflection over that assembly rather than by name alone:
    // `Type.GetType` cannot see an internal type in a referenced assembly.
    private static readonly Type Lifecycle = typeof(GameBuddy.Stardew.ModEntry).Assembly
        .GetType("GameBuddy.Stardew.SleepAndAdvanceDayLifecycle", throwOnError: true)!;

    [Fact]
    public void TheTerminalSettlesAStandingMenuBeforeItProjectsItsReceipt()
    {
        // Ordering is the assertion, not the existence of a method. A settle that ran AFTER the terminal evidence was
        // built would leave a receipt saying "nothing standing" about a menu it then closed - and one that ran after
        // the handle is dropped would never run at all.
        string finish = MethodBody(ReadLifecycleSource(), "private void Finish(");

        int settle = finish.IndexOf("SettleStandingSettlementMenu()", StringComparison.Ordinal);
        int project = finish.IndexOf("BuildReceiptEvidence(", StringComparison.Ordinal);

        settle.Should().BeGreaterThanOrEqualTo(0, "the terminal must settle a standing menu");
        project.Should().BeGreaterThanOrEqualTo(0, "the terminal still projects its receipt");
        settle.Should().BeLessThan(project, "settle first: a receipt that says nothing was standing must be true when built");
    }

    [Fact]
    public void AMenuThisLifecycleAlreadyCommittedIsNotCommittedTwice()
    {
        // `okClicked` is not idempotent in effect: it restarts the outro fade (ShippingMenu.cs:690-696), so dispatching
        // it again while that outro runs freezes the menu. The guard is per menu INSTANCE, so a later night's fresh
        // menu is still committed.
        string commit = MethodBody(ReadLifecycleSource(), "private SettlementMenuOutcome CommitShippingSummary(");

        commit.Should().Contain("committedShippingSummary", "the once-only guard must be per instance");
        commit.Should().Contain("ReferenceEquals", "an instance comparison, not an equality of contents");

        string decide = MethodBody(ReadLifecycleSource(), "internal static SettlementMenuOutcome DecideSettlementMenuCommit(");
        decide.Should().Contain("AlreadyCommitted", "an already-committed menu is reported, not silently skipped");
    }

    [Theory]
    [InlineData(false, false, "NotPresent")]
    [InlineData(true, false, "Committed")]
    [InlineData(true, true, "AlreadyCommitted")]
    public void TheOutcomeNamesWhatHappenedRatherThanOnlyWhetherItWorked(bool standing, bool alreadyCommitted, string expected)
    {
        // Four outcomes, because a receipt saying only `settled=true` cannot distinguish "I closed it" from "it was
        // never there" from "somebody else already had it". The companion's own report is built from this word.
        var decide = Lifecycle.GetMethod("DecideSettlementMenuCommit",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public);
        decide.Should().NotBeNull();

        object? outcome = decide!.Invoke(null, new object[] { standing, alreadyCommitted });
        outcome!.ToString().Should().Be(expected);
    }

    [Fact]
    public void EveryOutcomeHasAWordForTheReceipt()
    {
        // A missing arm would make the describe call throw inside the TERMINAL, which is the worst place to throw: it
        // would lose the receipt for the night that just succeeded.
        var describe = Lifecycle.GetMethod("DescribeSettlementMenuOutcome",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public);
        describe.Should().NotBeNull();
        Type outcomeType = describe!.GetParameters()[0].ParameterType;

        foreach (string name in Enum.GetNames(outcomeType))
        {
            object value = Enum.Parse(outcomeType, name);
            string? described = describe.Invoke(null, new[] { value }) as string;
            described.Should().NotBeNullOrWhiteSpace($"the terminal must be able to name {name}");
        }
    }

    [Fact]
    public void TheCloseGoesThroughTheEngineCommitRatherThanAGenericExit()
    {
        // ShippingMenu overrides neither `exitThisMenu` nor `cleanupBeforeExit`, so a generic close is a pure cancel
        // that discards the settlement. `okClicked` (ShippingMenu.cs:690-696) is the engine's own commit.
        //
        // The check reads CODE with its comments stripped first: `exitThisMenu` legitimately appears in the two comments
        // that explain why it is not used, and a whole-file search cannot tell an explanation from a call.
        string code = StripComments(ReadLifecycleSource());
        code.Should().Contain("okClicked", "the engine's own commit");
        code.Should().NotContain("exitThisMenu", "a generic exit would discard the settlement");
    }

    /// <summary>Removes `//` line comments and `/* */` blocks so an assertion reads CALLS, not prose about them.</summary>
    private static string StripComments(string source)
    {
        var withoutBlocks = System.Text.RegularExpressions.Regex.Replace(
            source, @"/\*.*?\*/", string.Empty, System.Text.RegularExpressions.RegexOptions.Singleline);
        return System.Text.RegularExpressions.Regex.Replace(withoutBlocks, @"//.*?$", string.Empty,
            System.Text.RegularExpressions.RegexOptions.Multiline);
    }

    private static string ReadLifecycleSource() =>
        System.IO.File.ReadAllText(RepositoryFile("integrations/stardew/SleepAndAdvanceDayLifecycle.cs"));

    private static string RepositoryFile(string relative)
    {
        var directory = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !System.IO.Directory.Exists(System.IO.Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return System.IO.Path.Combine(directory!.FullName, relative);
    }

    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int brace = source.IndexOf('{', start);
        int depth = 0;
        for (int index = brace; index < source.Length; index += 1)
        {
            if (source[index] == '{') depth += 1;
            else if (source[index] == '}')
            {
                depth -= 1;
                if (depth == 0) return source.Substring(brace, index - brace + 1);
            }
        }

        throw new InvalidOperationException($"{signature} has unbalanced braces");
    }
}
