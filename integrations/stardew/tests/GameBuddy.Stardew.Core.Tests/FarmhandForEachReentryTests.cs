using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A pass that ends because the actor is busy re-enters, and the row it already settled must not come back as a row nobody
/// claimed.
///
/// <para>
/// MEASURED 2026-11-11 (`round45`, `plan_66_dc0f5736a9faf977`): a 48-tile `cut_weeds` pass over seven weeds answered
/// <c>decided=48;succeeded=0;failed=0;refused=0;not_matched=48</c> and the node settled <c>failed</c>. The weeds WERE cut -
/// the same area's next observation carried seven <c>weeds_cut</c> receipts and the tiles were bare - because
/// <c>cut_weeds</c> walks the actor in: its first dispatch per pass answers with a receipt that has not settled, the pass
/// reports that row <see cref="FarmhandForEachTargetOutcome.Deferred"/> plus every remaining row, the node re-enters, and
/// by then the tile the pass opened no longer satisfies <c>occupant: weed</c>. The rows the pass worked disappeared from
/// its own counts.
/// </para>
/// <para>
/// THE SAME DOCUMENT WITH `slot` AND WITHOUT IT MATCHES THE SAME ROWS - the step's arguments are lifted at dispatch and
/// never consulted by <see cref="FarmhandForEachRules"/> - so "the two loops disagree about how many rows match" is a
/// statement about the re-entry, not about the argument.
/// </para>
/// </summary>
public sealed class FarmhandForEachReentryTests
{
    /// <summary>
    /// THE GATE, over the catalogue rather than over a list. Population: every action the catalogue publishes as
    /// <see cref="FarmhandActionApproachRequirement.SelfWalked"/> - the actions that walk the actor in themselves and
    /// therefore answer with a receipt that has not settled, which is what ends a pass early.
    ///
    /// <para>
    /// Property: across the re-entries, every row the pass dispatched is reported with the outcome its receipt settled
    /// to, and the pass that finishes the work settles it successfully. A row reported
    /// <see cref="FarmhandForEachTargetOutcome.NotMatched"/> after the pass itself worked it is the defect: the counts
    /// say "nothing happened" over a tile that was opened.
    /// </para>
    /// </summary>
    [Fact]
    public void EverySelfWalkedActionKeepsTheRowsItSettledAcrossAReentry()
    {
        var failures = new List<string>();
        int examined = 0;
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor?.Approach?.Relation != FarmhandActionApproachRequirement.SelfWalked.Relation) continue;
            examined += 1;
            FarmhandForEachSource strip = Area(60, 18, 2, 1);
            var loop = new FarmhandForEachLoop(
                strip,
                new[] { Unworked() },
                new FarmhandForEachEffect(new FarmhandForEachStep(registration.ActionId)));
            var world = new WorkedWorld();

            Pass(loop, world);
            world.Settle();
            FarmhandForEachPassResult second = Pass(loop, world);
            world.Settle();
            FarmhandForEachPassResult terminal = Pass(loop, world);

            foreach (FarmhandForEachTargetResult row in terminal.Targets)
                if (row.Outcome != FarmhandForEachTargetOutcome.Succeeded)
                    failures.Add(string.Create(
                        CultureInfo.InvariantCulture,
                        $"for_each_row_lost_across_reentry:{registration.ActionId}:{row.Tile ?? "no_tile"} "
                        + $"(the terminal pass answered {row.Outcome}/{row.ReasonCode ?? "no_reason"}, "
                        + $"second pass answered deferred={second.Deferred}, worked={world.Worked.Count})"));

            ForEachPassVerdict verdict = RouteReenteringBodyProgramExecutor.VerdictFor(terminal);
            if (verdict != ForEachPassVerdict.Succeeded)
                failures.Add(string.Create(
                    CultureInfo.InvariantCulture,
                    $"for_each_row_lost_across_reentry:{registration.ActionId}:verdict "
                    + $"(the pass that finished the work settled {verdict}: succeeded={terminal.Succeeded}, "
                    + $"not_matched={terminal.NotMatched}, deferred={terminal.Deferred})"));

            if (world.Worked.Count != terminal.Succeeded)
                failures.Add(string.Create(
                    CultureInfo.InvariantCulture,
                    $"for_each_row_lost_across_reentry:{registration.ActionId}:dispatch_count "
                    + $"(the world worked {world.Worked.Count} rows, the terminal pass counted {terminal.Succeeded})"));
        }

        examined.Should().BeGreaterThan(0, "the catalogue publishes self-walked actions, so the population is never empty");
        failures.Should().BeEmpty(
            $"a pass may not report its own work as rows nobody claimed; examined {examined} self-walked actions");
    }

    /// <summary>
    /// THE OTHER HALF: a receipt that has NOT settled is still the row's, and it stays <c>deferred</c>.
    ///
    /// <para>
    /// A row that was worked and whose native body is still running is neither "done" nor "a row nobody claimed". It is
    /// the same `deferred` the dispatched row was, which is what keeps the pass re-entering until the world says how it
    /// ended - collapsing it into either neighbour would either end a node early or lose a tile.
    /// </para>
    /// </summary>
    [Fact]
    public void ARowWhoseReceiptHasNotSettledStaysDeferredInsteadOfNotMatched()
    {
        FarmhandForEachSource strip = Area(60, 18, 1, 1);
        var loop = new FarmhandForEachLoop(strip, new[] { Unworked() }, new FarmhandForEachEffect(new FarmhandForEachStep("cut_weeds")));
        var world = new WorkedWorld();

        FarmhandForEachPassResult first = Pass(loop, world);
        FarmhandForEachPassResult second = Pass(loop, world);

        first.Targets.Single().Outcome.Should().Be(FarmhandForEachTargetOutcome.Deferred);
        second.Targets.Single().Outcome.Should().Be(
            FarmhandForEachTargetOutcome.Deferred,
            "the row's receipt is still running, so the row is neither finished nor unclaimed");
        second.Targets.Single().ReasonCode.Should().Be("in_flight", "the row answers with its own receipt's reason");
        RouteReenteringBodyProgramExecutor.VerdictFor(second).Should().Be(
            ForEachPassVerdict.Continue,
            "an unsettled row keeps the node re-entering; it does not decide the pass");
    }

    private static FarmhandForEachPassResult Pass(FarmhandForEachLoop loop, WorkedWorld world) =>
        FarmhandForEachExpansion.Expand(
            loop,
            "pass_reentry",
            world.Rows(loop.Source),
            world.Dispatch,
            () => false,
            _ => true,
            world.Settled);

    private static FarmhandForEachPredicate Unworked() =>
        new("worked", FarmhandForEachComparison.Eq, new[] { FarmhandForEachValue.Of(false) });

    private static FarmhandForEachSource Area(int x, int y, int w, int h) =>
        new(FarmhandForEachSource.AreaKind, x, y, w, h);

    /// <summary>
    /// The farm as the pass reads it, and the world's own answer about working one row.
    ///
    /// One fact models the live defect: the row's own dispatch makes it stop satisfying the predicate (`worked`), and the
    /// receipt it answers with has not settled until the native body releases the actor between two passes. It replays a
    /// request identity the way the router does, so a second dispatch of the same row is the same receipt.
    /// </summary>
    private sealed class WorkedWorld
    {
        private readonly Dictionary<string, LocalExecutionReceipt> receipts = new(StringComparer.Ordinal);

        internal HashSet<(int X, int Y)> Worked { get; } = new();

        internal IEnumerable<FarmhandForEachRow> Rows(FarmhandForEachSource source) =>
            FarmhandForEachRules.AreaRows(source).Select(row => new FarmhandForEachRow(
                row.X,
                row.Y,
                row.LocalColumn,
                row.LocalRow,
                new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
                {
                    ["kind"] = FarmhandForEachValue.Of("ground"),
                    [FarmhandForEachHealing.OccupantField] = FarmhandForEachValue.Of(FarmhandForEachHealing.NoOccupant),
                    ["worked"] = FarmhandForEachValue.Of(this.Worked.Contains((row.X, row.Y))),
                }));

        internal LocalExecutionReceipt? Settled(string requestId) =>
            this.receipts.TryGetValue(requestId, out LocalExecutionReceipt? receipt) ? receipt : null;

        /// <summary>The native body finishes: what was in flight is now the receipt the ledger holds.</summary>
        internal void Settle()
        {
            foreach (string requestId in this.receipts.Keys.ToArray())
                if (!this.receipts[requestId].State.IsTerminal())
                    this.receipts[requestId] = this.receipts[requestId] with
                    {
                        State = ExecutionState.Succeeded,
                        ReasonCode = "worked",
                    };
        }

        internal bool Dispatch(
            FarmhandForEachTarget target,
            string requestId,
            string executionId,
            out LocalExecutionReceipt receipt,
            out string reasonCode)
        {
            reasonCode = "accepted";
            if (this.receipts.TryGetValue(requestId, out LocalExecutionReceipt? recorded))
            {
                receipt = recorded;
                return true;
            }
            this.Worked.Add((target.X ?? -1, target.Y ?? -1));
            receipt = new LocalExecutionReceipt(executionId, requestId, ExecutionState.Running, "in_flight", 1, null, target.ActionId);
            this.receipts[requestId] = receipt;
            return true;
        }
    }
}
