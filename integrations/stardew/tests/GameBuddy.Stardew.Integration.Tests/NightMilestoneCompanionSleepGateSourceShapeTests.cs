using System;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The night-time milestone gate must read the companion's own bed, and nothing about the host player.
///
/// <para>
/// Measured 2026-11-05 (`.live-runs/game-ladder/2026-11-05T11-37-35-764Z-multiday_routine`): at 22:00 she answered
/// that she would stay up, and then heard nothing for 175 s until the engine passed her out at 26:00; the run was
/// judged `companion_did_not_sleep`. The gate had been keyed on the CLOCK (`600,1200,1800,2200`), which is the wrong
/// fact: what decides whether an hour is news is whether SHE has gone to bed.
/// </para>
/// <para>
/// The behaviour lives in `SalientEventFilter` and is driven by `GameBuddy.Stardew.Core.Tests/SensoryEventFilterTests`.
/// What is pinned here is the engine member the hook feeds it, because that is where the two players can be confused:
/// in a shared save her sleeping does not cut the host's day, so the host player's bed state must not influence the
/// decision in either direction.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class NightMilestoneCompanionSleepGateSourceShapeTests
{
    [Fact]
    public void TheTimeChangedHookFeedsHerOwnBedStateAndNothingElse()
    {
        string hook = WithoutComments(ReadHooksSource());

        string timeChanged = MethodBody(hook, "public void OnTimeChanged(");
        timeChanged.Should().Contain(
            "CompanionInBed()",
            "the milestone decision must be told whether SHE is in bed, and the read belongs to the one hook that raises it");

        // No parameter: a caller cannot hand the gate a farmer, so the gate cannot be pointed at another player.
        string bedState = MethodBody(hook, "internal static bool CompanionInBed()");
        bedState.Should().Contain(
            "Game1.player.isInBed.Value",
            "`Game1.player` is this AI Farmhand's own farmer on its configured screen, so this flag is hers");
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
            "companionInBed",
            "in bed is the reason to stay silent, and it must be a term of the decision itself");
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
            "a clock fact is emitted only while the companion is awake; being in bed is the reason to stay silent",
            "the invariant has to survive the next edit that touches the allowlist");

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
