using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ONE DECLARATION OF "TERMINAL", SO ONE ANNOUNCEMENT PER TERMINAL.
///
/// <para>
/// <c>ExecutionStateWire.IsTerminal</c> declares which states settle an execution; <c>ExecutionManager</c>'s terminal
/// commit announces <c>body_idle</c> - the fact that says the actor is free and where it stands - for a state the seam
/// considers terminal. When the seam kept its own, smaller copy of that list, the SAME terminal outcome announced the
/// idle or not depending on which path wrote the receipt: a <c>Rejected</c> tool approach
/// (<c>farmhandexecutioncontroller.resourcetoolactions.cs:1759</c>) announced it, a <c>Rejected</c> night
/// (<c>farmhandexecutioncontroller.lifecycleactions.cs:168</c>) announced it, and a fifth of the population announced
/// nothing. Those pins replace the copy with the declaration.
/// </para>
///
/// <para>
/// The population is read off <c>ExecutionStateWire.IsTerminal</c> itself, so a state added to the enum later is
/// covered here without editing this file. An extra <c>body_idle</c> costs the Host one evictable latest-only progress
/// slot (<c>host/src/event-pump.ts</c>); a missing one leaves a companion holding a settled execution and no
/// actor-free fact, which is the failure this file exists to prevent.
/// </para>
/// </summary>
public sealed class TerminalIdlePublicationTests
{
    [Fact]
    public void EveryTerminalStateAnnouncesTheBodyIdleExactlyOnce()
    {
        TraceProbe probe = TraceProbe.Create();
        ExecutionState[] terminals = DeclaredStates(terminal: true);

        terminals.Should().NotBeEmpty("the population is read from IsTerminal(), and an empty one would agree with itself");
        foreach (ExecutionState terminal in terminals)
            probe.Commit(terminal);

        probe.IdleExecutions().Should().BeEquivalentTo(
            terminals.Select(ExecutionIdOf),
            "every state IsTerminal() declares is a settled execution whose body came back");
        probe.IdleExecutions().Should().OnlyHaveUniqueItems("one execution announces its idle once");
    }

    [Fact]
    public void TheStatesThatStillOccupyTheBodyAnnounceNothing()
    {
        TraceProbe probe = TraceProbe.Create();
        ExecutionState[] occupied = DeclaredStates(terminal: false);

        occupied.Should().NotBeEmpty("an execution that has not settled must not announce a free body");
        foreach (ExecutionState state in occupied)
            probe.Commit(state);

        probe.IdleExecutions().Should().BeEmpty(
            "Accepted, Running and MeaningfulProgress are the states an execution still occupies");
    }

    /// <summary>Every state the enum declares, split by the one reader that decides what "terminal" means.</summary>
    private static ExecutionState[] DeclaredStates(bool terminal) =>
        Enum.GetValues<ExecutionState>().Where(state => state.IsTerminal() == terminal).ToArray();

    private static string ExecutionIdOf(ExecutionState state) => $"execution_{state}";

    private static string RequestIdOf(ExecutionState state) => $"request_{state}";

    /// <summary>
    /// The real ledger with the two publication funnels it has in production, plus one terminal commit per state. The
    /// receipts are driven straight through <see cref="IExecutionLedger.RememberTerminal"/>, which is the seam every
    /// family calls: no native world is needed to ask whether a terminal state announces the idle.
    /// </summary>
    private sealed class TraceProbe
    {
        private readonly List<ExecutionTrace> traces = new();
        private readonly IExecutionLedger ledger;

        private TraceProbe(ExecutionManager manager)
        {
            this.ledger = manager;
        }

        internal static TraceProbe Create()
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
            TraceProbe? probe = null;
            var manager = new ExecutionManager(
                new DummyMonitor(),
                () => publication,
                tracePublished: trace => probe?.traces.Add(trace));
            probe = new TraceProbe(manager);
            return probe;
        }

        /// <summary>One terminal commit through the seam, as the action families write them.</summary>
        internal void Commit(ExecutionState state) =>
            this.ledger.RememberTerminal(RequestIdOf(state), ExecutionIdOf(state), state, $"reason_{state}", evidence: null);

        /// <summary>The executions the ledger announced as free, one entry per <c>body_idle</c> fact it published.</summary>
        internal IReadOnlyList<string> IdleExecutions() =>
            this.traces.Where(trace => trace.Category == "body_idle").Select(trace => trace.ExecutionId).ToList();
    }
}
