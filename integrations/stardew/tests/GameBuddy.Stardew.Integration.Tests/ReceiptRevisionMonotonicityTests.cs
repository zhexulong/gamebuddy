using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The published receipt revision must be strictly monotonic PER EXECUTION, and it is the Host that enforces it.
///
/// Measured 2026-10-17 (three times, on the first multi-day live runs): the Mod minted
/// `Running/tool_approach_completed` and then `Succeeded/crop_harvested` for the same execution with the SAME
/// revision, because the mint sites read a world counter shared with the action's own mutation. The Host audits
/// receipt order and refuses an equal revision carrying different content
/// (`execution_receipt_replay_rejected:non_monotonic_revision`, receipt-replay.ts:49) - correctly, since such a
/// frame is indistinguishable from a rewrite of a settled transition. A refused receipt is a fatal transport
/// fault, so the whole run died with an artifact that could not say why.
///
/// The fix belongs in the ONE delivery funnel (`AddTrace`), because the aliasing is inherent to reading that
/// shared counter on both sides of a mutation. These assertions are source-level because the funnel is called
/// from ~120 native mint sites; a live run is the only other place the ordering is observable.
/// </summary>
public sealed class ReceiptRevisionMonotonicityTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    private static string ReadExecutionController()
    {
        string path = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            RepositoryRelativeRoot,
            "integrations",
            "stardew",
            "farmhandexecutioncontroller.cs"));
        return File.ReadAllText(path);
    }

    private static string PublishFunnelBody()
    {
        string source = ReadExecutionController();
        // The funnel RETURNS the receipt it published, so the caller answers with the same bytes the fact stream carries.
        int start = source.IndexOf("private LocalExecutionReceipt AddTrace(LocalExecutionReceipt receipt)", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, "the delivery funnel must exist");
        // The WHOLE method, not up to any one marker inside it: the publish and the trace line are both part of
        // the funnel and their order is what the assertions below are about.
        int end = source.IndexOf("\n    }\n", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start);
        return source[start..end];
    }

    [Fact]
    public void TheFunnelHandsBackTheReceiptItPublished()
    {
        // The caller answers with this object and the fact stream carries it, so handing back the MINTED receipt
        // published a fact without `held_ms` while the response carried it - same revision, different content, which
        // the Host refuses as `non_monotonic_revision` (named live 2026-10-21: same execution, revision 266, same
        // state and reason, different evidence).
        PublishFunnelBody().Should().EndWith("return published;", "the funnel hands back what it published");
        // The durability-failure early returns keep answering with the minted receipt on purpose: nothing was
        // published on that path, so there is no published copy to hand back.
        PublishFunnelBody().Should().Contain("if (ModEntry.IsUnconfirmedTerminal(receipt.State))");
    }

    [Fact]
    public void TheDeliveryFunnelTracksWhatWasPublishedPerExecution()
    {
        string source = ReadExecutionController();
        source.Should().Contain(
            "private readonly Dictionary<string, long> publishedReceiptRevisionByExecutionId",
            "the published revision per execution is the value the Host audits against");
        // It must be keyed by execution, not by request: one execution's transitions are the sequence at issue.
        source.Should().Contain("StringComparer.Ordinal", "the map is keyed by an opaque id");
    }

    [Fact]
    public void ANonIncreasingPublishedRevisionIsReplacedWithAHigherOne()
    {
        PublishFunnelBody()
            .Should()
            .Contain(
                "receipt.Revision <= publishedRevision",
                "an equal OR lower revision with different content is the exact defect");
        PublishFunnelBody().Should().Contain("receipt with { Revision = this.revision }");
        PublishFunnelBody()
            .Should()
            .Contain(
                "Math.Max(this.revision, publishedRevision + 1)",
                "the shared counter must be lifted too, so later mints do not repeat the colliding number");
    }

    [Fact]
    public void TheFunnelPublishesTheAdjustedReceiptAndRemembersIt()
    {
        string body = PublishFunnelBody();
        // What is REMEMBERED must be what is PUBLISHED, or the next comparison reads a stale number.
        body.Should().Contain("this.Remember(published);");
        // And the emitted object is the adjusted one, not the minted one.
        body.Should().Contain("this.receiptPublished?.Invoke(published);");
        body.Should().NotContain("this.receiptPublished?.Invoke(receipt);");
        // The trace marker must report the PUBLISHED revision, since that is what a live diagnosis compares.
        body.Should().Contain("revision={published.Revision}", "the logged revision must be the published one");
        body.Should().NotContain("revision={receipt.Revision}");
    }

    [Fact]
    public void AFirstPublicationOfAnExecutionIsLeftAlone()
    {
        // An execution's first published transition has nothing to compare against, so it keeps the minted
        // revision: rewriting it would make every receipt a bump and hide the real counter from a reader.
        string body = PublishFunnelBody();
        body.Should().Contain("publishedRevision != 0", "the guard is for a KNOWN earlier publication");
        body.Should().Contain("TryGetValue(receipt.ExecutionId, out long publishedRevision)");
    }
}
