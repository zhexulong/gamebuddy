using System;
using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// "No lifecycle can commit this settlement sheet" is a question about CAPABILITY, not about progress.
///
/// <para>
/// Four commits have fixed the same morning deadlock - `1b70f08e`, `541775c2`, `4357a95b`, `76c51da4` - and every one of
/// them asked whether the lifecycle had FINISHED. That is a question about how far it got, and it comes apart from
/// whether it can still act in exactly the situation that keeps recurring.
/// </para>
/// <para>
/// MEASURED 2026-10-31: the clock read 2600 (the 2:00 AM pass-out), the engine warped to FarmHouse and ran `NewDay`, the
/// next day opened at 600, and `menu=ShippingMenu` then stood for the rest of the run. The lifecycle that should have
/// settled it was still alive and unfinished, so the day start answered "someone owns this" and skipped - while that
/// someone was sitting in `AwaitingSave` with no route to the commit, because the ONLY phase that commits a settlement
/// sheet is `AwaitingModal`, and that phase is entered from exactly one place: `WalkToBed()` returning true. A pass-out
/// night never walks to the bed.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class SettlementMenuCapabilitySourceShapeTests
{
    [Fact]
    public void TheDayStartAsksWhetherTheOwnerCanStillActRatherThanWhetherItFinished()
    {
        string guard = WithoutComments(MethodBody(
            ReadLifecycleSource(),
            "internal static void SettleStandingSettlementMenuNoLifecycleCanCommit("));

        guard.Should().Contain(
            "CanStillCommitSettlementMenu",
            "ownership must be decided by whether the owner still has a route to the commit");
        // COMMENTS ARE STRIPPED. The first draft asserted on the raw body and went red on the comment that EXPLAINS why
        // `IsFinished` was the wrong question - a gate its own prose can satisfy (or in this case, fail) is a gate that
        // has stopped working. This repository has paid for that mistake three times.
        guard.Should().NotContain(
            "!owner.IsFinished",
            "`IsFinished` answers how far the lifecycle got, which is true of a lifecycle that can no longer act");
    }

    /// <summary>The source with `//` and `/* */` comments removed, so an assertion cannot read prose.</summary>
    private static string WithoutComments(string source) =>
        Regex.Replace(Regex.Replace(source, @"/\*[\s\S]*?\*/", string.Empty), @"(^|[^:])//.*$", "$1", RegexOptions.Multiline);

    [Fact]
    public void TheCapabilityNamesEveryPhaseThatCommitsTheSummary()
    {
        // Read the property rather than restate the set: a second spelling of "can commit" is the defect this test
        // exists to prevent, so the assertion takes its population from the file's own `case` labels and requires the
        // property to cover every phase in which the commit is reachable.
        string lifecycle = ReadLifecycleSource();
        string capability = MethodBody(lifecycle, "internal bool CanStillCommitSettlementMenu");

        // The modal the rollover raises before the prompt, and the three waits for the crossing itself: those are the
        // phases that meet the summary, and `AdvanceEngineCrossingMenu` is what each of them advances it with.
        foreach (string phase in new[] { "AwaitingModal", "AwaitingSettlement", "AwaitingSave", "AwaitingDayStart" })
        {
            capability.Should().Contain($"Phase.{phase}", $"{phase} meets the summary and must keep ownership of it");
            lifecycle.Should().Contain($"case Phase.{phase}:", $"Phase.{phase} must be a phase this lifecycle really has");
        }

        // And the commit is reachable in each of them, which is what the capability claims. The night the engine took by
        // its own 2:00 AM pass-out never walks to the bed, so the capability may not be reachable only through the walk.
        foreach (string owner in new[]
        {
            "private bool AnswerSleepPrompt(",
            "private bool ObserveSaveBoundary(",
            "private bool EvaluateDayStart(",
        })
        {
            MethodBody(lifecycle, owner).Should().Contain($"AdvanceEngineCrossingMenu", $"{owner} meets the summary");
        }
    }

    [Fact]
    public void AFinishedLifecycleIsNotACapableOne()
    {
        string capability = MethodBody(ReadLifecycleSource(), "internal bool CanStillCommitSettlementMenu");
        capability.Should().Contain("!this.finished", "a finished lifecycle owns nothing, whatever phase it last reported");
    }

    private static string ReadLifecycleSource() =>
        File.ReadAllText(
            Path.Combine(
                RepositoryRoot(),
                "integrations",
                "stardew",
                "SleepAndAdvanceDayLifecycle.cs"));

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }

    /// <summary>The body of one member, from its declaration to the matching close brace.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int at = source.IndexOf(declaration, StringComparison.Ordinal);
        at.Should().BeGreaterThanOrEqualTo(0, $"`{declaration}` must exist");
        int depth = 0;
        bool started = false;
        for (int i = source.IndexOf('{', at); i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
                started = true;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (started && depth == 0) return source[at..(i + 1)];
            }
        }
        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }
}
