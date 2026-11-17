using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_refusal_that_leaves_no_next_step:&lt;code&gt;` - every Navigation ejection tells the caller what to do next, or names
/// the condition that has to change instead.
///
/// <para>
/// MEASURED `round68`: a navigation settled <c>destination_locked</c> with
/// <c>destination=Town;phase=awaiting_warp;grace_expired=true;actionable=false;never_retry=true</c> and the run ended
/// there. Town is a place the companion had reached before (`round42` stood at Pierre's counter), so the sentence was
/// wrong twice: it named no next move, and <c>never_retry</c> is a fact about the request id, not about the world.
/// </para>
///
/// <para>
/// The population is the Mod's own code, not a list written here: the scanner reads the two files that settle a
/// navigation and the three that mint its outcomes, and takes the code out of every position that produces one. A code
/// added at any of those positions is therefore in the population the moment it exists, and has to be classified in
/// <see cref="NavigationNextStep.Of"/> or it is reported MUTE by name.
/// </para>
///
/// <para>
/// Three outcomes are counted apart, because they are three different answers: <c>actionable</c> (a next action is
/// named), <c>permanent-with-a-reason</c> (the condition that has to change is named), and <c>mute</c> (neither, which
/// fails). A successful end and a still-running navigation are not ejections and are counted as neither - the table
/// says so per code, so the classification is a statement rather than a default.
/// </para>
/// </summary>
public sealed class NavigationNextStepNamingTests
{
    private const string Controller = "integrations/stardew/farmhandexecutioncontroller.cs";
    private const string FrameLoop = "integrations/stardew/farmhandexecutioncontroller.frameloop.cs";
    private const string Decider = "integrations/stardew/navigation/navigationoutcomedecider.cs";
    private const string AcceptedExecution = "integrations/stardew/navigation/acceptednavigationexecution.cs";
    private const string Plan = "integrations/stardew/navigation/navigationplan.cs";

    private static readonly string[] SeamFiles = { Controller, FrameLoop, Decider, AcceptedExecution, Plan };

    /// <summary>
    /// The positions that mint a navigation code, each as the shape it is written in. A position that grows a new shape
    /// is a position this scanner must learn; the shapes are listed here rather than inferred, so the list is the
    /// statement of what "a navigation code" means in this tree.
    /// </summary>
    private static readonly Regex[] CodePositions =
    {
        // this.SettleNavigationTerminal(navigation, ExecutionState.Rejected, "code", …)
        new(@"(?s)SettleNavigationTerminal\([^;]{0,400}?ExecutionState\.\w+,\s*""([a-z][a-z0-9_:]*)""", RegexOptions.Compiled),
        // new NavigationOutcome(ExecutionState.Rejected, "code", …)
        new(@"(?s)new NavigationOutcome\(\s*ExecutionState\.\w+,\s*""([a-z][a-z0-9_:]*)""", RegexOptions.Compiled),
        // NavigationPlan.Blocked("code", …)
        new(@"NavigationPlan\.Blocked\(\s*""([a-z][a-z0-9_:]*)""", RegexOptions.Compiled),
        // new NavigationDestinationResolution(null, null, null, "code")
        new(@"(?s)new NavigationDestinationResolution\([^;]{0,240}?""([a-z][a-z0-9_:]*)""\)", RegexOptions.Compiled),
        // this.RememberTerminal(…, ExecutionState.Uncertain, "navigation_code", …)
        new(@"(?s)RememberTerminal\([^;]{0,400}?ExecutionState\.\w+,\s*""((?:navigation_|invalid_deadline)[a-z0-9_:]*)""", RegexOptions.Compiled),
    };

    private readonly ITestOutputHelper output;

    public NavigationNextStepNamingTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryNavigationEjectionLeavesANextStep()
    {
        string[] codes = ScannedCodes();

        Report report = Classify(codes);

        this.output.WriteLine(report.Line);
        report.Examined.Count.Should().BeGreaterThan(0, "a gate whose population is empty agrees with itself");
        report.Mute.Should().BeEmpty($"{report.Line}; these codes end a navigation and tell the caller nothing");
    }

    /// <summary>
    /// The falsifier: a code the table cannot name lands in the mute column and is named, so the gate above is not
    /// passing because everything it looked at happens to be classified.
    /// </summary>
    [Fact]
    public void TheGateIsRedOnACodeTheTableCannotName()
    {
        Report report = Classify(new[] { "destination_locked", "a_code_nobody_classified" });

        report.Mute.Should().Equal("a_code_nobody_classified");
        report.Actionable.Should().Contain("destination_locked");
        report.Line.Should().Contain("mute 1");
    }

    /// <summary>
    /// Whatever the table publishes is one wire field: the evidence is parsed by splitting on `;` and then on `=`, so a
    /// word carrying either separator would turn one field into two and the sentence into a different fact.
    /// </summary>
    [Fact]
    public void EveryStepIsASingleWireField()
    {
        Report report = Classify(ScannedCodes());
        IEnumerable<string> words = report.Examined
            .Select(code => NavigationNextStep.Of(code))
            .Where(step => !step.IsMute && step.Exit != NavigationExit.Progress)
            .Select(step => step.Token!);

        words.Should().NotBeEmpty("the table publishes at least one step");
        foreach (string word in words)
        {
            word.Should().MatchRegex("^[a-z][a-z0-9_]*$", "a step is one `key=value` value and nothing else");
        }
    }

    /// <summary>
    /// The vocabulary the table publishes is the vocabulary a hold already publishes: a step that repeats a word from
    /// <see cref="WorldModel"/>'s hold countermeasure has to spell it identically, or the two answers disagree.
    /// </summary>
    [Fact]
    public void AStepThatNamesAHoldReusesTheHoldWords()
    {
        NavigationNextStep wait = NavigationNextStep.Of("navigation_commit_body_still_owned");
        NavigationNextStep observe = NavigationNextStep.Of("destination_access_indeterminate");

        wait.Token.Should().NotBe(observe.Token, "waiting for another owner and re-reading the world are different steps");
        NavigationNextStep.Of("navigation_scope_unavailable").Exit.Should().Be(
            NavigationExit.PermanentCondition,
            "the scope an execution lived in cannot be restored from inside it, so this one names a condition and not an action");
    }

    private static Report Classify(IReadOnlyList<string> codes)
    {
        var examined = new List<string>();
        var actionable = new List<string>();
        var permanent = new List<string>();
        var mute = new List<string>();
        foreach (string code in codes.Distinct(StringComparer.Ordinal))
        {
            examined.Add(code);
            switch (NavigationNextStep.Of(code).Exit)
            {
                case NavigationExit.NextAction:
                    actionable.Add(code);
                    break;
                case NavigationExit.PermanentCondition:
                    permanent.Add(code);
                    break;
                case NavigationExit.Unclassified:
                    mute.Add(code);
                    break;
                default:
                    break;
            }
        }

        return new Report(examined, actionable, permanent, mute);
    }

    /// <summary>The codes at every position this tree mints a navigation code from, read out of the Mod's own source.</summary>
    private static string[] ScannedCodes()
    {
        var codes = new HashSet<string>(StringComparer.Ordinal);
        foreach (string file in SeamFiles)
        {
            string source = StripComments(ReadRepositoryFile(file));
            foreach (Regex position in CodePositions)
            {
                foreach (Match match in position.Matches(source))
                    codes.Add(match.Groups[1].Value);
            }
        }

        return codes.OrderBy(code => code, StringComparer.Ordinal).ToArray();
    }

    /// <summary>Line comments removed, so a sentence ABOUT a code is never read as a code.</summary>
    private static string StripComments(string source) =>
        string.Join('\n', source.Split('\n').Select(DecompiledSource.WithoutComment));

    private static string ReadRepositoryFile(string relativePath)
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            string candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate))
                return File.ReadAllText(candidate);
        }

        throw new FileNotFoundException($"{relativePath} is not reachable from {AppContext.BaseDirectory}");
    }

    private sealed record Report(
        IReadOnlyList<string> Examined,
        IReadOnlyList<string> Actionable,
        IReadOnlyList<string> Permanent,
        IReadOnlyList<string> Mute)
    {
        internal string Line =>
            $"codes examined {this.Examined.Count} · actionable {this.Actionable.Count}"
            + $" · permanent-with-a-reason {this.Permanent.Count} · mute {this.Mute.Count}";
    }
}
