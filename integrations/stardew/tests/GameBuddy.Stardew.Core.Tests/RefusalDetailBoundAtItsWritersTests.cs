using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// THE BOUND BELONGS TO THE WRITER, NOT TO THE REFUSAL.
///
/// <para>
/// Measured `round92`: `plan_703` (`move_to_tile` 71,51) and `plan_745` (`navigate_to_destination` Mountain) were refused
/// `no_native_path` with 544 and 698 characters of route evidence. The executor carried that evidence into
/// <c>RefusalDetail</c> verbatim, the journal refused anything over
/// <see cref="BodyProgramValidation.MaximumNodeRefusalDetailLength"/>, and the controller answered that `InvalidInput` by
/// settling the node `RecoveryRequired` with `terminal_rejected_by_authority` - so two ordinary refusals stopped their
/// programs while every shorter `no_native_path` of the same run stayed an ordinary `Failed`. A real refusal must never
/// change its STATE because its text was long.
/// </para>
/// <para>
/// The readings here are of the SETTLEMENT the executor mints, not of a private helper, because the settlement is what the
/// journal is handed. <c>OpenBodyProgramJournalAuthority.TryComplete</c> keeps refusing a detail the writer left unbounded
/// (`BodyProgramAuthorityTests.ARefusalDetailIsRefusedWhereItWouldBeASecondClaim`), which is why the bound cannot live in
/// the consumer.
/// </para>
/// </summary>
public sealed class RefusalDetailBoundAtItsWritersTests
{
    private static readonly NodeExecutionBinding Execution = new("plan_703", "n1", 1, "req_1", "idem_1", "exec_1");

    /// <summary>The route facts `no_native_path` composes, before the pass appended coordinate after coordinate.</summary>
    private const string RouteEvidence =
        "from=71,49;to=71,51;component_tiles=19;target_enclosed=true;route_exists_cardinal=false;closest=71,50"
        + ";closest_distance=1;blocked_by:stone@71,50";

    /// <summary>An evidence string of exactly <paramref name="length"/> characters, built from the route facts above.</summary>
    private static string Evidence(int length) => LongEvidence()[..length];

    private static string LongEvidence()
    {
        var evidence = new StringBuilder(RouteEvidence, 4096);
        for (int tile = 0; evidence.Length < 4096; tile += 1)
            evidence.Append(CultureInfo.InvariantCulture, $";component_tile={tile},51");
        return evidence.ToString();
    }

    private static LocalExecutionReceipt Refusal(string evidence) =>
        new("exec_1", "req_1", ExecutionState.Rejected, "no_native_path", 7, evidence, ActionId: "move_to_tile");

    private static BodyProgramTerminalResult Settlement(string evidence) =>
        RouteReenteringBodyProgramExecutor.SettleWithoutProof(Execution, Refusal(evidence), BodyProgramNodeOutcome.Failed);

    /// <summary>
    /// `round92`'s two measured lengths settle as the refusals they are, with the reason detail bounded where it was
    /// written and the count it could not carry named.
    /// </summary>
    [Theory]
    [InlineData(544)]
    [InlineData(698)]
    public void Round92sTwoRefusalLengthsStayTheRefusalsTheyAre(int evidenceLength)
    {
        string evidence = Evidence(evidenceLength);

        BodyProgramTerminalResult terminal = Settlement(evidence);

        terminal.Outcome.Should().Be(
            BodyProgramNodeOutcome.Failed,
            "a refused route is a refuted node; the journal promotes a node it cannot store to RecoveryRequired, which stops the program");
        terminal.FailureCode.Should().Be("no_native_path");
        terminal.Evidence.Should().BeNull("ADR-006 :175 gives evidence to a node that proved an effect, and this one proved none");
        BodyProgramValidation.IsValidRefusalDetail(terminal.RefusalDetail).Should().BeTrue(
            $"a detail the journal refuses is a node the authority settles as RecoveryRequired: {evidenceLength} characters became "
            + $"{(terminal.RefusalDetail is null ? "null" : terminal.RefusalDetail.Length.ToString(CultureInfo.InvariantCulture))}");
        string detail = terminal.RefusalDetail!;
        int marker = detail.IndexOf(";truncated=", StringComparison.Ordinal);
        marker.Should().BeGreaterThan(
            0,
            "everything that fits is the refusing layer's own words, and only the part that did not fit is cut");
        detail[..marker].Should().Be(evidence[..marker], "the kept text is the refusal verbatim, not a re-composition of it");
        int.Parse(detail[(marker + ";truncated=".Length)..], CultureInfo.InvariantCulture)
            .Should().Be(evidenceLength - marker, "the marker names exactly how many characters the bound left out");
    }

    /// <summary>
    /// The class, not the two instances: every length of evidence from none to well past the bound settles with a detail
    /// the journal accepts. The boundary is the point - 511, 512 and 513 are three different programs if the writer is
    /// off by one.
    /// </summary>
    [Fact]
    public void EveryLengthOfEvidenceSettlesWithADetailTheJournalAccepts()
    {
        int examined = 0;
        var refused = new List<string>();
        int bound = BodyProgramValidation.MaximumNodeRefusalDetailLength;
        for (int length = 0; length <= bound * 2 + 176; length += 1)
        {
            BodyProgramTerminalResult terminal = Settlement(Evidence(length));
            examined += 1;
            if (!BodyProgramValidation.IsValidRefusalDetail(terminal.RefusalDetail))
                refused.Add(
                    $"{length}->{(terminal.RefusalDetail is null ? "null" : terminal.RefusalDetail.Length.ToString(CultureInfo.InvariantCulture))}");
        }

        examined.Should().Be(bound * 2 + 177, "the sweep is the population, so a shorter one is a weaker reading");
        refused.Should().BeEmpty(
            $"a refusal the journal refuses is settled as RecoveryRequired instead of Failed; lengths over the {bound}-character bound must arrive bounded");
    }

    /// <summary>
    /// The two plainest ways a writer's text can be one the journal will not store beside a state: it is empty, or it
    /// carries a line break. Neither is the caller's reason, and neither may cost the node its state.
    /// </summary>
    [Fact]
    public void EvidenceThatIsEmptyOrCarriesALineBreakStillSettlesAsAReasonTheJournalAccepts()
    {
        BodyProgramTerminalResult none = Settlement(string.Empty);
        none.RefusalDetail.Should().BeNull("a refusal that computed no detail states none - an empty string is not one the journal accepts");

        BodyProgramTerminalResult broken = Settlement("from=71,49\r\nblocked_by=stone@71,50");
        BodyProgramValidation.IsValidRefusalDetail(broken.RefusalDetail).Should().BeTrue(
            "a control character would let the detail forge a line of its own, and refusing it at the journal costs the node its state");
        broken.RefusalDetail.Should().Contain("from=71,49").And.Contain("blocked_by=stone@71,50");
    }
}
