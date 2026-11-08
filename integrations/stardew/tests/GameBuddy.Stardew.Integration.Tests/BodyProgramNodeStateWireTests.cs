using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What the Mod's status snapshot says about a node, for the states the journal actually settles nodes in.
///
/// <para>
/// THE MEASURED DEFECT (2026-11-08). One run's bundle recorded 154 node outcomes, 31 of them `recovery_required` - and
/// the same run's durable journal held 30 `skipped_dependency`, 1 `abandoned` and ZERO `recovery_required`. The 31 were
/// not a condition: `BodyProgramNodeState` has eleven values, the wire projection named nine, and the two it did not name
/// fell through `ToWire`'s catch-all into `recovery_required`, which already means "the outcome could not be
/// determined". A dependency skip and an unreadable outcome are different facts and a reader that cannot tell them
/// apart cannot research either.
/// </para>
/// <para>
/// These cases drive the SAME projection the game answers `program_status` with (`BridgeSession.ToBridgeSnapshot`,
/// called from `TryProgramStatus`/`TryProgramSubmit`/`TryProgramStop`), not a test-only copy of it.
/// </para>
/// </summary>
public sealed class BodyProgramNodeStateWireTests
{
    private static NodeExecutionBinding Binding(string nodeId) =>
        new("program_1", nodeId, 1, "request_1", "idempotency_1", "execution_1");

    private static BodyProgramStatusSnapshot Snapshot(params BodyProgramJournalNode[] nodes) =>
        new("program_1", BodyProgramState.Failed, 7, 2, 11, nodes,
            // One `Work` row per node, because that is the shape the authority builds: the wire projection JOINS this list
            // by node id, so an empty one here would assert a snapshot the authority never produces - and would leave the
            // actionId/tile assertions below unable to tell a build fix from a projection that stopped carrying them.
            nodes.Select(node => new BodyProgramNodeWork(node.NodeId, "till_soil", 4, 7)).ToArray());

    [Fact]
    public void AProgramWhoseMiddleNodeWasADependencySkipNamesThatStateInsteadOfFoldingItIntoRecoveryRequired()
    {
        // Three nodes: the first and last ran and succeeded, the middle one was never attempted because its dependency
        // did not settle the way it needed - the ordinary shape of the 30 skipped nodes in the measured journal.
        var snapshot = Snapshot(
            new BodyProgramJournalNode("n01", BodyProgramNodeState.Succeeded, 1, 1, null, Binding("n01")),
            new BodyProgramJournalNode("n02", BodyProgramNodeState.SkippedDependency, 0, 0, null, null),
            new BodyProgramJournalNode("n03", BodyProgramNodeState.Succeeded, 1, 1, null, Binding("n03")));

        BridgeBodyProgramStatusSnapshot projected = BridgeSession.ToBridgeSnapshot(snapshot)!;

        projected.Nodes.Select(node => node.State).Should().Equal("succeeded", "skipped_dependency", "succeeded");
        projected.Nodes.Should().NotContain(node => node.State == "recovery_required");
        // The other half of what a reader needs: WHICH action each node ran, and the tile it addressed. A state without
        // those is the "15 plan submissions, 0 tiles tilled" answer this projection exists to stop.
        projected.Nodes.Select(node => node.ActionId).Should().Equal("till_soil", "till_soil", "till_soil");
        projected.Nodes.Select(node => node.X).Should().Equal(4, 4, 4);
        projected.Nodes.Select(node => node.Y).Should().Equal(7, 7, 7);
    }

    [Fact]
    public void AnAbandonedNodeNamesItself()
    {
        // A node that WAS dispatched and whose outcome can never be determined: terminal, and the reason
        // `recovery_required` must stop being borrowed for.
        var snapshot = Snapshot(new BodyProgramJournalNode("n01", BodyProgramNodeState.Abandoned, 1, 1, null, Binding("n01")));

        BridgeBodyProgramStatusSnapshot projected = BridgeSession.ToBridgeSnapshot(snapshot)!;

        projected.Nodes[0].State.Should().Be("abandoned");
    }

    [Fact]
    public void AnUnmappedNodeStateFailsClosedAndNamesItself()
    {
        // A default arm that relabels an unknown state as a MEANINGFUL one is the defect family here, so the state that
        // no arm names must arrive as itself: a name no reader can mistake for a condition, and one the wire validator
        // refuses (`BridgeProtocol.IsBodyProgramNodeState`), so such a frame cannot be published as a real state.
        var snapshot = Snapshot(new BodyProgramJournalNode("n01", (BodyProgramNodeState)99, 0, 0, null, null));

        BridgeBodyProgramStatusSnapshot projected = BridgeSession.ToBridgeSnapshot(snapshot)!;

        projected.Nodes[0].State.Should().Be("body_program_node_state_unmapped:99");
        projected.Nodes[0].State.Should().NotBe("recovery_required");
        // "Fails closed" is not just "has an odd name": the frame carrying it cannot be serialized, because the wire
        // validator refuses a state it cannot name - so the refusal happens HERE, at the Mod, rather than being read
        // downstream as a condition.
        BridgeProtocol.TrySerialize(new BridgeBodyProgramStatusResult("found", projected), out _, out _).Should().BeFalse();
    }
}
