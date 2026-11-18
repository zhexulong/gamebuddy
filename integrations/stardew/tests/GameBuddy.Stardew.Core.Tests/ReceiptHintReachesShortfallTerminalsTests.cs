using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A receipt's `Hint` reaches the node on EVERY terminal that may carry one.
///
/// <para>
/// `Hint` is the one actionable part of a settled refusal: `BodyProgramValidation.MaximumNodeHintLength` characters of
/// `blocker_occupant=weed@40,9;clears_with=cut_weeds;stand_at=41,8`, and ADR-006 withholds the evidence it was projected
/// from, so the node's `hint` is the only channel the model reads it on. `OpenBodyProgramJournalAuthority.TryComplete`
/// stores it on every outcome that settled short of succeeding; the executor is the layer that decides what a receipt
/// OFFERS there, and its `Cancelled` arm answered `null` while its `Failed` arm passed `receipt.Hint` (measured
/// 2026-11-19). Two terminals of the same legal shape, and only one of them reached a model with the route facts.
/// </para>
/// <para>
/// The population is not a list of states this file remembered: it is every terminal <see cref="ExecutionState"/> whose
/// settled outcome is one the journal stores a reason on (`Failed`/`Cancelled` through
/// <see cref="RouteReenteringBodyProgramExecutor.OutcomeForTerminalState"/>). A state added to the enum, or a mapping that
/// changes its answer, joins this check on its own. The failure names the state that dropped the fact.
/// </para>
/// </summary>
public sealed class ReceiptHintReachesShortfallTerminalsTests
{
    private const string Hint = "blocker_occupant=weed@40,9;clears_with=cut_weeds;stand_at=41,8";
    private const string ReasonCode = "no_native_path";
    private const string Evidence = "from=40,7;to=44,9;component_tiles=19;target_enclosed=true";

    private static readonly NodeExecutionBinding Execution = new("plan_1", "n1", 1, "req_1", "idem_1", "exec_1");

    /// <summary>The receipt a refusal mints: a reason code, the route facts, and the evidence they were projected from.</summary>
    private static LocalExecutionReceipt Receipt(ExecutionState state) =>
        new("exec_1", "req_1", state, ReasonCode, 7, Evidence, ActionId: "move_to_tile", Hint: Hint);

    /// <summary>Every terminal whose node outcome is one the journal stores a reason on, from the two authorities.</summary>
    private static IReadOnlyList<(ExecutionState State, BodyProgramNodeOutcome Outcome)> ReasonCarryingTerminals() =>
        Enum.GetValues<ExecutionState>()
            .Where(state => state.IsTerminal())
            .Select(state => (State: state, Outcome: RouteReenteringBodyProgramExecutor.OutcomeForTerminalState(state)))
            .Where(candidate => candidate.Outcome is BodyProgramNodeOutcome.Failed or BodyProgramNodeOutcome.Cancelled)
            .Select(candidate => (candidate.State, candidate.Outcome!.Value))
            .OrderBy(candidate => candidate.State.ToString(), StringComparer.Ordinal)
            .ToArray();

    /// <summary>
    /// The check, over an injected settlement so a mutation can be shown to make it red. `measured` is what the test
    /// prints: a guard that passes on an empty population agrees with itself.
    /// </summary>
    private static void AssertReasonReachesTheNode(
        Func<LocalExecutionReceipt, BodyProgramNodeOutcome, BodyProgramTerminalResult> settle,
        string because)
    {
        IReadOnlyList<(ExecutionState State, BodyProgramNodeOutcome Outcome)> population = ReasonCarryingTerminals();
        population.Should().NotBeEmpty("a reason-carrying terminal population of zero would make this check pass by itself");

        var dropped = new List<string>();
        foreach ((ExecutionState state, BodyProgramNodeOutcome outcome) in population)
        {
            BodyProgramTerminalResult result = settle(Receipt(state), outcome);
            bool carried =
                result.Outcome == outcome &&
                result.Hint == Hint &&
                result.FailureCode == ReasonCode &&
                result.RefusalDetail == Evidence &&
                result.Facts is { Count: 0 } &&
                result.ReceiptId is null &&
                result.Evidence is null &&
                result.PostconditionVerification is null;
            if (!carried)
                dropped.Add(
                    $"{state}->{outcome}: hint={(result.Hint is null ? "null" : "present")}," +
                    $" reason={(result.FailureCode is null ? "null" : "present")}," +
                    $" detail={(result.RefusalDetail is null ? "null" : "present")}," +
                    $" outcome={result.Outcome}");
        }

        dropped.Should().BeEmpty($"{population.Count} terminal state(s) settle with a reason, so each must carry it: {because}");
    }

    [Fact]
    public void EveryTerminalThatSettlesShortOfSucceedingCarriesTheReceiptsReasonAndHint()
    {
        AssertReasonReachesTheNode(
            (receipt, outcome) => RouteReenteringBodyProgramExecutor.SettleWithoutProof(Execution, receipt, outcome),
            "the node's hint is the only channel a settled failure has for the route facts ADR-006 withholds");
    }

    /// <summary>The falsifier: the same check, driven by the settlement this test replaced, must name the state.</summary>
    [Fact]
    public void TheSameCheckFailsOnASettlementThatDropsTheHintForACancellation()
    {
        Action dropped = () => AssertReasonReachesTheNode(
            (receipt, outcome) => outcome == BodyProgramNodeOutcome.Cancelled
                ? RouteReenteringBodyProgramExecutor.SettleWithoutProof(Execution, receipt, outcome) with { Hint = null }
                : RouteReenteringBodyProgramExecutor.SettleWithoutProof(Execution, receipt, outcome),
            "injected: a cancellation that drops its hint");

        dropped.Should().Throw<Exception>()
            .WithMessage("*Cancelled*", "the mutation drops the hint on exactly the cancelled terminals")
            .WithMessage("*hint=null*");
    }

    /// <summary>
    /// The control, in the other direction: an UNKNOWN outcome may carry none of the three. A receipt on that path proves
    /// nothing about why anything stopped, so a hint there would be a claim the authority never made.
    /// </summary>
    [Fact]
    public void AnUncertainOutcomeCarriesNoReasonStatementAtAll()
    {
        BodyProgramTerminalResult result = RouteReenteringBodyProgramExecutor.SettleWithoutProof(
            Execution,
            Receipt(ExecutionState.Uncertain),
            BodyProgramNodeOutcome.Uncertain);

        result.Outcome.Should().Be(BodyProgramNodeOutcome.Uncertain);
        result.FailureCode.Should().BeNull();
        result.Hint.Should().BeNull();
        result.RefusalDetail.Should().BeNull();
    }

    /// <summary>
    /// The population this check runs over, printed so a shrinking one is visible: seven terminals settle with a reason.
    /// </summary>
    [Fact]
    public void TheCheckedPopulationIsTheReasonCarryingTerminalsTheProductDeclares()
    {
        IReadOnlyList<(ExecutionState State, BodyProgramNodeOutcome Outcome)> population = ReasonCarryingTerminals();

        population.Should().NotBeEmpty();
        population.Select(candidate => candidate.State).Should().BeEquivalentTo(new[]
        {
            ExecutionState.Blocked,
            ExecutionState.Invalidated,
            ExecutionState.PartiallySucceeded,
            ExecutionState.Failed,
            ExecutionState.Cancelled,
            ExecutionState.Rejected,
            ExecutionState.Expired,
        });
        population.Count(candidate => candidate.Outcome == BodyProgramNodeOutcome.Cancelled)
            .Should().Be(2, "Cancelled and Invalidated both settle a node as cancelled, and both may name why");
        population.Count(candidate => candidate.Outcome == BodyProgramNodeOutcome.Failed)
            .Should().Be(5, "Blocked, Expired, Invalidated-by-receipt and Rejected all settle a node as failed");
    }
}
