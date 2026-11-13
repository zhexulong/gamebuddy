using System;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The night-time milestone gate must read whether HER DAY HAS ENDED, and nothing about the host player.
///
/// <para>
/// Measured 2026-11-05 (`.live-runs/game-ladder/2026-11-05T11-37-35-764Z-multiday_routine`): at 22:00 she answered
/// that she would stay up, and then heard nothing for 175 s until the engine passed her out at 26:00; the run was
/// judged `companion_did_not_sleep`. The gate had been keyed on the CLOCK (`600,1200,1800,2200`), which is the wrong
/// fact: what decides whether an hour is news is whether SHE has ended her day.
/// </para>
/// <para>
/// The behaviour lives in `SalientEventFilter` and is driven by `GameBuddy.Stardew.Core.Tests/SensoryEventFilterTests`.
/// What is pinned here is the engine member the hook feeds it, because that is the layer that was wrong twice in one
/// direction each: first the hour, then - measured 2026-11-22 (`round53`) - `Farmer.isInBed`, which the assembly shows
/// is set true when she answers the sleep prompt (`GameLocation.answerDialogueAction`) and CLEARED BY NOBODY, so after
/// her first night it stays true for the rest of the process. Her clock went 06:10 -> 16:20 (610 game minutes) with
/// `BRIDGE_FACT 0` and no `1200` milestone: she was standing in the farmhouse, awake, and the gate read a flag that
/// says "has slept at least once".
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class NightMilestoneCompanionSleepGateSourceShapeTests
{
    [Fact]
    public void TheClockGateNeverDecidesFromTheEngineBedFlag()
    {
        string hook = WithoutComments(ReadHooksSource());

        // A class-level rule, not one pinned line: no member of this file may decide anything from where she is
        // STANDING. `isInBed` is set by `GameLocation.answerDialogueAction` when the sleep prompt is answered and no
        // path in `Stardew Valley.dll` sets it back to false, so a decision keyed on it silences every hour after her
        // first night - the whole of `round53`.
        hook.Should().NotContain(
            "isInBed",
            "`Farmer.isInBed` is latched true by the sleep prompt and never cleared, so it cannot answer 'is her day "
            + "over'; a gate that reads it silences every milestone for the rest of the process");
    }

    [Fact]
    public void TheSleepGateIsHerBedtimeAndTheEngineClearsItEveryMorning()
    {
        string hook = WithoutComments(ReadHooksSource());

        string timeChanged = MethodBody(hook, "public void OnTimeChanged(");
        timeChanged.Should().Contain(
            "CompanionAsleep()",
            "the milestone decision must be told whether SHE has ended her day, and the read belongs to the one hook that raises it");

        // No parameter: a caller cannot hand the gate a farmer, so the gate cannot be pointed at another player.
        string sleepState = MethodBody(hook, "internal static bool CompanionAsleep()");
        sleepState.Should().Contain(
            "Game1.player.timeWentToBed",
            "`GameLocation.startSleep` writes her bedtime into `Farmer.timeWentToBed` and `Farmer.dayupdate` clears it "
            + "to 0 at the start of each day, so the fact cannot outlive the night it describes");
    }

    [Fact]
    public void TheHostPlayerGoingToBedDoesNotSilenceHerClock()
    {
        string hook = WithoutComments(ReadHooksSource());

        // Both directions of the host relationship are decided by the same property: the hook never names the host.
        hook.Should().NotContain(
            "MasterPlayer",
            "the host's own `Farmer` is not the companion, so whether the host is lying down cannot silence her hour");
        hook.Should().NotContain(
            "otherFarmers",
            "a shared save lets other farmers be in bed while she is awake and the day unadvanced");
    }

    [Fact]
    public void TheHostPlayerStayingUpDoesNotWakeHerFromBed()
    {
        string filter = WithoutComments(ReadFilterSource());

        string milestone = MethodBody(filter, "public bool IsTimeMilestoneSalient(");
        milestone.Should().Contain(
            "companionAsleep",
            "her day having ended is the reason to stay silent, and it must be a term of the decision itself");
        milestone.Should().NotContain(
            "Game1",
            "the filter stays a pure decision over the states it is given, so no second game state can leak into it");
    }

    [Fact]
    public void TheClockKeepsTellingAnAwakeCompanionThatTheNightIsAdvancing()
    {
        string filter = ReadFilterSource();

        // Comments are NOT stripped here: the sentence IS the invariant a later reader has to preserve, and it is the
        // one place that says why the hour alone cannot decide.
        filter.Should().Contain(
            "a clock fact is emitted only while her day is still hers; having gone to bed is the reason to stay silent",
            "the invariant has to survive the next edit that touches the allowlist, and it must say DAY rather than "
            + "BED: the bed flag is latched, the bedtime is not");

        string milestones = WithoutComments(filter);
        milestones.Should().Contain(
            "2400",
            "midnight is the hour a companion who chose to stay up has to hear about");
        MethodBody(milestones, "private static readonly HashSet<int> AllowedMilestones").Should().NotContain(
            "2600",
            "the engine's own pass-out fact is published at 26:00, so a milestone there would tell the same moment twice");
    }

    /// <summary>The source with `//` and `/* */` comments removed, so an assertion cannot read prose.</summary>
    private static string WithoutComments(string source) =>
        Regex.Replace(Regex.Replace(source, @"/\*[\s\S]*?\*/", string.Empty), @"(^|[^:])//.*$", "$1", RegexOptions.Multiline);

    private static string ReadHooksSource() =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), "integrations", "stardew", "Sensory", "StardewSalientEventHooks.cs"));

    private static string ReadFilterSource() =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), "integrations", "stardew", "Sensory", "ISalientEventFilter.cs"));

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
