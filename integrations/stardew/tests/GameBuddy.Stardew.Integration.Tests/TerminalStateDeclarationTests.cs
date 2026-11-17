using System;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ONE DECLARATION OF "TERMINAL", AND THE WHOLE ENUM ANSWERED BY IT.
///
/// <para>
/// <c>ExecutionStateWire.IsTerminal</c> is the single reader that decides whether an execution has settled. The durable
/// journal's receipt ranking, the modal owner lease and the Host's terminal-receipt classification all read it - so a
/// state the enum carries and this split does not classify is a state no reader can act on. The last time the list was
/// copied instead of read, the same terminal outcome announced the actor free on one path and nothing on another.
/// </para>
///
/// <para>
/// The population is <see cref="Enum.GetValues{TEnum}"/> itself, so a state added to the enum later is covered here
/// without editing this file. What this file no longer asserts is a <c>body_idle</c> publication: that was a trace of
/// the body rather than a change of the world, and the executor no longer produces one. The declaration it read is what
/// remains, and it is the thing worth pinning.
/// </para>
/// </summary>
public sealed class TerminalStateDeclarationTests
{
    [Fact]
    public void EveryDeclaredStateIsEitherSettledOrOccupied()
    {
        ExecutionState[] terminals = DeclaredStates(terminal: true);
        ExecutionState[] occupied = DeclaredStates(terminal: false);
        int examined = Enum.GetValues<ExecutionState>().Length;

        terminals.Should().NotBeEmpty("the population is read from IsTerminal(), and an empty one would agree with itself");
        occupied.Should().NotBeEmpty("an execution that has not settled is a state the enum must also name");
        terminals.Should().OnlyHaveUniqueItems();
        occupied.Should().OnlyHaveUniqueItems();
        terminals.Intersect(occupied).Should().BeEmpty("a state cannot both settle an execution and still occupy the body");
        (terminals.Length + occupied.Length).Should().Be(examined, "the two sets together are the whole enum");
    }

    [Fact]
    public void TheThreeStatesThatStillOccupyTheBodyAreTheOnlyOnes()
    {
        DeclaredStates(terminal: false).Should().BeEquivalentTo(
            new[] { ExecutionState.Accepted, ExecutionState.Running, ExecutionState.MeaningfulProgress },
            "these three are what the receipt publication, the journal ranking and the Host read as 'still in flight'");
    }

    /// <summary>Every state the enum declares, split by the one reader that decides what "terminal" means.</summary>
    private static ExecutionState[] DeclaredStates(bool terminal) =>
        Enum.GetValues<ExecutionState>().Where(state => state.IsTerminal() == terminal).ToArray();
}
