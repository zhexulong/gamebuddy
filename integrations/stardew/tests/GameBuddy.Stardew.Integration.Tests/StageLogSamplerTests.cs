using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The per-tick stage markers are a SAMPLE of where the lane is, and this holds the law that makes them one: every
/// stage prints when it is first sighted, and after that the whole family prints at most once per window.
///
/// The defect this replaces cost two diagnoses. Every <c>*_done</c> marker was forced past the throttle, so the family
/// wrote a line up to four times a second for the life of a run - 8 991 lines in one multiday run - and twice the
/// newest <c>capability_publication_done</c> was read as the run's "last line" when nothing about the stages had
/// changed. A marker that prints on every tick is a heartbeat, and the lane already has one.
///
/// The tick is driven explicitly (both the tick number and the clock are parameters) because the claim is about how
/// many lines a FIXED NUMBER OF TICKS produces, which a real fixture could only answer by running the game.
/// </summary>
public sealed class StageLogSamplerTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    /// <summary>One engine tick at 60 fps, so a simulated second is exactly 60 ticks.</summary>
    private const int FrameMs = 16;

    private const long WindowMs = 2_000L;

    private static readonly Regex StageCall = new("LogStageOnce\\(([^)]*)\\)", RegexOptions.CultureInvariant);

    private static string RepositoryPath(string relativePath) =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relativePath));

    /// <summary>The native-local lane: from the tick handler to the line where that lane publishes and yields.</summary>
    private static string LaneSource()
    {
        string source = File.ReadAllText(RepositoryPath(Path.Combine("integrations", "stardew", "ModEntry.cs")));
        int start = source.IndexOf("private void OnUpdateTicked(", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, "the tick handler is where the stage markers live");
        int end = source.IndexOf("PublishPendingStopObservation(nativeLocalState);", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start, "the lane's own tail anchors the slice");
        return source[start..end];
    }

    /// <summary>Each stage call's argument list, verbatim, in the order the lane enters them.</summary>
    private static string[] LaneArguments() =>
        StageCall.Matches(LaneSource()).Select(match => match.Groups[1].Value.Trim()).ToArray();

    /// <summary>
    /// The stages the lane enters on every tick it gets past its gates, read from the lane itself - so a stage added
    /// there is driven by these tests without anyone editing a list here.
    /// </summary>
    private static string[] LaneStages() => LaneArguments().Select(argument => argument.Trim('"')).ToArray();

    /// <summary>Drives the lane's stages for a number of ticks at 60 fps and returns the lines it would print.</summary>
    private static List<string> RunTicks(ModEntry mod, int ticks)
    {
        string[] stages = LaneStages();
        stages.Should().NotBeEmpty("a lane with no stage markers is a lane a frozen log cannot describe");
        var lines = new List<string>();
        for (int tick = 1; tick <= ticks; tick += 1)
        {
            foreach (string stage in stages)
            {
                if (mod.StageLogLine(stage, (tick - 1) * FrameMs, tick) is string line)
                    lines.Add(line);
            }
        }
        return lines;
    }

    [Fact]
    public void OneSecondOfTicksPrintsEachStageOnceAndNothingPerTick()
    {
        using ModEntry mod = new();
        List<string> lines = RunTicks(mod, ticks: 60);

        lines.Should().HaveCount(
            LaneStages().Distinct(StringComparer.Ordinal).Count(),
            "a second of ticks is one sighting of the lane's vocabulary and no per-tick repeats: {0}",
            string.Join(" | ", lines));
        lines.Select(line => Regex.Match(line, "stage=([a-z_]+)").Groups[1].Value)
            .Should().OnlyHaveUniqueItems("each stage is printed once, not once per tick");
    }

    [Fact]
    public void TenSecondsOfTicksCostsOneLinePerWindowAndNotOnePerTick()
    {
        const int seconds = 10;
        int ticks = seconds * 60;

        using ModEntry mod = new();
        List<string> lines = RunTicks(mod, ticks);

        int windows = (int)(((ticks - 1) * FrameMs) / WindowMs);
        lines.Should().HaveCount(
            LaneStages().Length + windows,
            "the vocabulary once, then one sample per {0} ms window - never one per tick",
            WindowMs);
        lines.Count.Should().BeLessThan(ticks, "one line per tick is the flood this family used to be");
    }

    [Fact]
    public void ARepeatInsideTheWindowIsSilentAndTheNextWindowNamesTheStageWithItsGap()
    {
        using ModEntry mod = new();

        mod.StageLogLine("bridge_drain", nowUnixMs: 0L, tick: 1).Should().NotBeNull("a stage's first sighting always prints");
        mod.StageLogLine("bridge_drain", nowUnixMs: FrameMs, tick: 2).Should().BeNull("the next tick is not a stage boundary");
        mod.StageLogLine("bridge_drain", nowUnixMs: WindowMs - 1, tick: 125).Should().BeNull("still inside the window");

        string? next = mod.StageLogLine("bridge_drain", nowUnixMs: WindowMs, tick: 126);
        next.Should().NotBeNull("the sample after the window still names the stage the lane is in");
        next.Should().Contain("stage=bridge_drain").And.Contain("tick=126").And.Contain("gap=125");
    }

    [Fact]
    public void AStageTheLogHasNeverShownPrintsImmediately()
    {
        using ModEntry mod = new();
        mod.StageLogLine("capability_publication", nowUnixMs: 0L, tick: 1).Should().NotBeNull();

        mod.StageLogLine("observe_bridge_generation", nowUnixMs: FrameMs, tick: 2)
            .Should().NotBeNull("the whole vocabulary stays visible even though the steady state is only a sample");
        mod.StageLogLine("observe_bridge_generation", nowUnixMs: FrameMs * 2, tick: 3)
            .Should().BeNull("...and its second sighting obeys the window");
    }

    [Fact]
    public void NoStageCallSitePassesABypassOrNamesAStageTwice()
    {
        string[] arguments = LaneArguments();
        arguments.Should().NotBeEmpty("the lane's markers are the population this pin is about");

        arguments
            .Where(argument => argument.Contains(',', StringComparison.Ordinal))
            .Should()
            .BeEmpty("a second argument is a per-tick bypass, which is the flood regardless of which stage asks for it");

        arguments
            .GroupBy(argument => argument, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .Should()
            .BeEmpty("the lane enters each stage once per tick; a repeat is a merge artifact, not a boundary");
    }
}
