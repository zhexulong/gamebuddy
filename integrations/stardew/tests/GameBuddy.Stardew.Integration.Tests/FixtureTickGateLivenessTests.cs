using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Every tick gate that yields must say so, and must serve the bridge first.
///
/// This is a source-pinned invariant because the failure it prevents is invisible in every other way. Three
/// separate live runs died the same death: the tick returned early (a probe owning the actor, the cross-day
/// lifecycle waiting for `DayStarted`, the fixture gate's `!Context.IsWorldReady` during the engine's own day
/// transition), the lane stopped answering the pipe, and the only bridge requests that could have unblocked the
/// step - closing the day-end `LevelUpMenu` that holds `DayStarted` - were never processed. Each time the Mod's
/// log simply stopped while the game process kept burning a full core, so it read as an engine freeze rather
/// than as a return (measured 2026-10-17, runs g16/g17/g21).
///
/// The rule the fixes converged on: a yield point that stops processing input must FIRST pump the connection, and
/// must name itself. This test holds both halves against the source, so adding another silent return fails here
/// instead of costing another night.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class FixtureTickGateLivenessTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    /// <summary>How far back a `return;` may reach for its own gate's line and pump.</summary>
    private const int GateWindowLines = 8;

    private static string ReadModEntry() =>
        File.ReadAllText(
            Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, "integrations", "stardew", "ModEntry.cs")));

    /// <summary>The gates of the native-local fixture lane, ending where that lane publishes and yields.</summary>
    private static string[] NativeLocalLaneLines()
    {
        string source = ReadModEntry();
        int start = source.IndexOf("private void OnUpdateTicked(", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, "the tick handler is the thing this invariant is about");
        // The lane ENDS with its observation publication; slicing to there covers every gate of that lane and
        // stops before the formal/co-op lane's gates, which are a different topology's business.
        int tail = source.IndexOf("PublishPendingStopObservation(nativeLocalState);", start, StringComparison.Ordinal);
        tail.Should().BeGreaterThan(start, "the native-local lane's tail is the end anchor for this slice");
        int end = source.IndexOf("return;", tail, StringComparison.Ordinal);
        end.Should().BeGreaterThan(tail);
        return source[start..(end + "return;".Length)].Split('\n');
    }

    [Fact]
    public void EveryYieldThatStopsTheNativeLocalLaneIsNamedAndPumpsTheBridge()
    {
        string[] lines = NativeLocalLaneLines();
        var unnamed = new List<string>();
        for (int index = 0; index < lines.Length; index += 1)
        {
            if (!string.Equals(lines[index].Trim(), "return;", StringComparison.Ordinal)) continue;
            int from = Math.Max(0, index - GateWindowLines);
            string window = string.Join('\n', lines[from..(index + 1)]);
            bool named = window.Contains("LogBlockedTickReasonOnce", StringComparison.Ordinal);
            bool pumps = window.Contains("PumpBridgeWhileBodyOwned", StringComparison.Ordinal);
            // The healthy end of the tick publishes its observation and yields on EVERY working tick, so it is not
            // a latch: it cannot be held while a step waits on the bridge.
            bool healthyTail = window.Contains("PublishPendingStopObservation", StringComparison.Ordinal);
            if (!(named && pumps) && !healthyTail)
            {
                unnamed.Add($"line {index + 1} (after `{lines[index - 1].Trim()}`)");
            }
        }
        unnamed.Should().BeEmpty(
            "a gate that stops answering the pipe can deadlock the very step it is waiting for: "
                + string.Join(" | ", unnamed));
    }

    [Fact]
    public void ThePumpServicesTheConnectionWithoutReleasingTheBody()
    {
        string source = ReadModEntry();
        int start = source.IndexOf("private void PumpBridgeWhileBodyOwned(", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0);
        string body = source[start..source.IndexOf("\n    }", start, StringComparison.Ordinal)];
        // It services the connection and the execution state machine...
        body.Should().Contain("DrainLocalPipeBridge(state);");
        body.Should().Contain("LogNativeLocalPipelineHeartbeat();");
        body.Should().Contain("state.Executions?.Update();");
        // ...and never touches ownership: releasing the body here would let two executions own one actor, which is
        // the invariant those gates exist to protect.
        body.Should().NotContain("ReleaseModalOwner");
        body.Should().NotContain("active = null");
        body.Should().NotContain("ClearState");
    }
}
