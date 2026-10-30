using System;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// `Blocked` and `Invalidated` are terminals, and nothing in this product may read them as "still running".
///
/// <para>
/// MEASURED 2026-10-30 (`round9`): `navigate_to_destination{Farm}` was refused
/// `state=Blocked;reason=destination_unreachable`. `RouteReenteringBodyProgramExecutor.ToTerminal` had `Blocked` and
/// `Invalidated` in its `default` arm - the arm that answers null, meaning "keep waiting" - so plan_942 stayed `active`
/// with its node `running` for the rest of the run. Every `stardew_action_program_status{waitMs:30000}` replayed the
/// same receipt for its full thirty seconds, the companion concluded navigation was stuck, wandered, and passed out in
/// town at 02:00.
/// </para>
/// <para>
/// The two facts below are the pair that was in contradiction: `ExecutionState.IsTerminal` (what the enum decides) and
/// `ModEntry.IsUnconfirmedTerminal` (what the delivery tracker decides). Both said terminal; the executor's switch was
/// the only place that disagreed, and it disagreed silently because its `default` arm is correct for the three states
/// that really are still running.
/// </para>
/// </summary>
public sealed class RouteExecutorTerminalAgreementTests
{
    [Fact]
    public void TheExecutorTreatsEveryBlockingTerminalAsSettled()
    {
        // These four are the ones the executor's switch had wrong or was missing. Asserted through the public outcome
        // they produce rather than through source text, so the check survives a refactor of how the switch is written.
        foreach (ExecutionState state in new[]
                 {
                     ExecutionState.Blocked,
                     ExecutionState.Invalidated,
                     ExecutionState.Expired,
                     ExecutionState.PartiallySucceeded,
                 })
            RouteReenteringBodyProgramExecutor.OutcomeForTerminalState(state)
                .Should()
                .NotBeNull($"{state} is a settled decision, so the node must stop waiting on it");

        // The control: the states that genuinely mean "the native body has not finished this attempt" must keep
        // waiting, or every in-flight receipt would settle a node on its first poll.
        foreach (ExecutionState inFlight in new[]
                 {
                     ExecutionState.Accepted,
                     ExecutionState.Running,
                     ExecutionState.MeaningfulProgress,
                 })
            RouteReenteringBodyProgramExecutor.OutcomeForTerminalState(inFlight)
                .Should()
                .BeNull($"{inFlight} means the attempt is still in progress");
    }

    [Fact]
    public void TheExecutorAndTheProductAgreeThatTheseStatesAreTerminal()
    {
        // BOTH SIDES, asserted where this assembly can see them. `ModEntry.IsUnconfirmedTerminal` lives in the Mod
        // assembly, which a Core test does not reference - so the pair is expressed as: the executor settles these, and
        // the states it does NOT settle are exactly the three the enum calls in-flight.
        //
        // Measured 2026-10-30 (`round9`): `navigate_to_destination{Farm}` was refused
        // `state=Blocked;reason=destination_unreachable`. The executor's `default` arm - which answers null = "keep
        // waiting" - contained `Blocked` and `Invalidated`, so plan_942 stayed `active` with its node `running` for the
        // rest of the run. Every `stardew_action_program_status{waitMs:30000}` replayed the same receipt for its full
        // thirty seconds, the companion decided navigation was stuck, wandered, and passed out in town at 02:00.
        var settled = Enum.GetValues<ExecutionState>()
            .Where(state => RouteReenteringBodyProgramExecutor.OutcomeForTerminalState(state) is not null)
            .ToArray();
        var waiting = Enum.GetValues<ExecutionState>()
            .Where(state => RouteReenteringBodyProgramExecutor.OutcomeForTerminalState(state) is null)
            .ToArray();

        // Every enum member is one or the other; nothing may be silently skipped.
        (settled.Length + waiting.Length).Should().Be(Enum.GetValues<ExecutionState>().Length);

        // The three that genuinely mean "this attempt has not finished" - and ONLY those.
        waiting.Should().BeEquivalentTo(new[]
        {
            ExecutionState.Accepted,
            ExecutionState.Running,
            ExecutionState.MeaningfulProgress,
        });

        // The three that were wrong, named so a regression reports which one.
        settled.Should().Contain(new[]
        {
            ExecutionState.Blocked,
            ExecutionState.Invalidated,
            ExecutionState.Expired,
        });
    }
}
