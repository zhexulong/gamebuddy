using System.Globalization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Diagnostics;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The contract of the one line a dispatched node prints: ONE line per node, only when the node cost more than half
/// a frame, carrying the seams it paid for - and nothing at all for the nodes that cannot be felt.
///
/// <para>
/// The meter is static state on purpose (one node in flight per game thread), so every test installs a sink and
/// removes it again. The assertions are read by the node's own request id rather than by "no line at all": the sink
/// is process-wide while the node is thread state, so a node another test dispatches in parallel can reach the same
/// sink, and only this node's line is this test's subject.
/// </para>
/// </summary>
public sealed class GameThreadCostTests
{
    [Fact]
    public void ANodeUnderHalfAFrame_NeverPrintsALineUnderTheThreshold()
    {
        var lines = new List<string>();
        GameThreadCost.Report = lines.Add;
        try
        {
            long? node = GameThreadCost.BeginDispatch("break_rock", "req_cheap");
            GameThreadCost.EndDispatch(node);
        }
        finally
        {
            GameThreadCost.Report = null;
        }

        // The assertion is the INVARIANT rather than "no line": a thread the scheduler parks for 8 ms really did
        // spend 8 ms in the node, and printing that is correct. What may never happen is a line quoting a total
        // under the threshold.
        foreach (string line in LinesFor(lines, "req_cheap"))
        {
            TotalMs(line).Should().BeGreaterThanOrEqualTo(
                8d,
                "a node cheaper than half a frame cannot be the hitch a player feels");
        }
    }

    [Fact]
    public void ANodeOverHalfAFrame_PrintsOneLineNamingEverySeam()
    {
        var lines = new List<string>();
        GameThreadCost.Report = lines.Add;
        try
        {
            long? node = GameThreadCost.BeginDispatch("break_rock", "req_expensive");
            long admission = GameThreadCost.BeginSeam();
            GameThreadCost.NoteSeam(GameThreadCost.AdmissionSeam, admission);
            long flood = GameThreadCost.BeginSeam();
            GameThreadCost.NoteFlood(flood, 4420);
            GameThreadCost.NoteOutcome("Accepted", "accepted");
            Thread.Sleep(20);
            GameThreadCost.EndDispatch(node);
        }
        finally
        {
            GameThreadCost.Report = null;
        }

        string line = LinesFor(lines, "req_expensive").Should().ContainSingle("one dispatched node is one line").Subject;
        line.Should().StartWith("[game-thread-cost] action=break_rock;node=none;request=req_expensive");
        line.Should().Contain(";admission_ms=");
        line.Should().Contain(";approach_ms=");
        line.Should().Contain(";flood_tiles=4420;");
        line.Should().Contain(";state=Accepted;reason=accepted");
    }

    [Fact]
    public void ANodeDispatchedInsideAnother_DoesNotCloseTheOuterNodesLine()
    {
        var lines = new List<string>();
        GameThreadCost.Report = lines.Add;
        try
        {
            long? outer = GameThreadCost.BeginDispatch("for_each", "req_outer");
            long? inner = GameThreadCost.BeginDispatch("break_rock", "req_inner");
            inner.Should().BeNull("the outer node owns the cost and its line carries it");
            GameThreadCost.EndDispatch(inner);
            LinesFor(lines, "req_outer").Should().BeEmpty("closing the inner dispatch must not print or reset the outer one");
            Thread.Sleep(20);
            GameThreadCost.EndDispatch(outer);
        }
        finally
        {
            GameThreadCost.Report = null;
        }

        string line = LinesFor(lines, "req_outer").Should().ContainSingle().Subject;
        line.Should().Contain("action=for_each;node=none;request=req_outer");
    }

    [Fact]
    public void ANodeNamedByTheProgrammeCarriesThePairTheJournalUses()
    {
        var lines = new List<string>();
        GameThreadCost.Report = lines.Add;
        try
        {
            using GameThreadCost.NodeScope node = new("plan_619/node_4");
            long? dispatch = GameThreadCost.BeginDispatch("break_rock", "req_named");
            Thread.Sleep(20);
            GameThreadCost.EndDispatch(dispatch);
        }
        finally
        {
            GameThreadCost.Report = null;
        }

        string line = LinesFor(lines, "req_named").Should().ContainSingle().Subject;
        line.Should().Contain("action=break_rock;node=plan_619/node_4;request=req_named");
    }

    [Fact]
    public void ASeamMeasuredOutsideAnyNode_IsAttributedToNothing()
    {
        long started = GameThreadCost.BeginSeam();

        started.Should().Be(0, "a seam measured outside a dispatch has no node to attribute its cost to");
        GameThreadCost.NoteSeam(GameThreadCost.ApproachSeam, started);
        GameThreadCost.NoteFlood(started, 4420);
        GameThreadCost.NoteOutcome("Succeeded", "weeds_cut");
    }

    [Fact]
    public void TheLine_RendersMillisecondsInInvariantCulture()
    {
        var lines = new List<string>();
        GameThreadCost.Report = lines.Add;
        try
        {
            long? node = GameThreadCost.BeginDispatch("break_rock", "req_milliseconds");
            Thread.Sleep(20);
            GameThreadCost.EndDispatch(node);
        }
        finally
        {
            GameThreadCost.Report = null;
        }

        string line = LinesFor(lines, "req_milliseconds").Should().ContainSingle().Subject;
        TotalMs(line).Should().BeGreaterThanOrEqualTo(8d, "the line only exists when the node crossed the threshold");
    }

    private static double TotalMs(string line)
    {
        string total = line.Split(';').Single(field => field.StartsWith("total_ms=", StringComparison.Ordinal));
        return double.Parse(total["total_ms=".Length..], NumberStyles.Float, CultureInfo.InvariantCulture);
    }

    private static IEnumerable<string> LinesFor(List<string> lines, string requestId) =>
        lines.Where(line => line.Contains($"request={requestId};", StringComparison.Ordinal));
}
