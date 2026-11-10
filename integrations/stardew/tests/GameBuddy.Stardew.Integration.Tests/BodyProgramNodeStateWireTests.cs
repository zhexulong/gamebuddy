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

    /// <summary>
    /// A PARTIAL PASS NAMES ITSELF ON THE WIRE, AND THE FRAME THAT CARRIES IT IS VALID.
    ///
    /// <para>
    /// The state is the middle of three, so both neighbours would be lies about it: `succeeded` would contradict the row
    /// table the same node carries (58 of 60 tiles), and the catch-all would report a verdict this product can state as one
    /// it could not name. The second half is the load-bearing one: the wire validator has its own copy of the vocabulary,
    /// so a state the journal can settle and the frame cannot carry would fail at the ONE boundary where the model reads
    /// the answer - and it would fail by turning the whole `program_status` frame into `invalid_body_program_result`.
    /// </para>
    /// </summary>
    [Fact]
    public void APartiallySucceededNodeNamesItselfAndItsFrameIsAcceptedByTheWire()
    {
        var snapshot = Snapshot(new BodyProgramJournalNode(
            "n01",
            BodyProgramNodeState.PartiallySucceeded,
            1,
            1,
            null,
            Binding("n01"),
            ReceiptId: "execution_1",
            Evidence: "{\"state\":\"partially_succeeded\",\"succeeded\":5,\"refused\":1}",
            PostconditionVerification: "for_each_pass:partially_succeeded:decided=6:succeeded=5:failed=0:refused=1",
            FailureCode: "row_target_absent:cut_weeds:weedtargets",
            Hint: "decided=6;succeeded=5;refused=1",
            RefusalDetail: "decided=6;succeeded=5;refused=1;row_target_absent:cut_weeds:weedtargets=1"));

        BridgeBodyProgramStatusSnapshot projected = BridgeSession.ToBridgeSnapshot(snapshot)!;

        projected.Nodes[0].State.Should().Be("partially_succeeded");
        // The proof of what happened and the reason for what did not travel TOGETHER on one node, in the fields each is
        // legal in - which is the whole difference between this state and the two it sits between.
        projected.Nodes[0].FailureCode.Should().Be("row_target_absent:cut_weeds:weedtargets");
        projected.Nodes[0].RefusalDetail.Should().NotBeNull();
        BridgeProtocol.TrySerialize(new BridgeBodyProgramStatusResult("found", projected), out _, out _).Should().BeTrue(
            "the frame a partial node arrives on is one the wire validator accepts");
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

    /// <summary>
    /// One projection, two spellings - and they must not drift.
///
/// <para>
/// A node reaches the wire through `BridgeSession.NodeStatus` (what the running game answers `program_status` with) or
/// through `BridgeProtocol.ProjectBodyProgramStatusSnapshot` (the Core-side projection). Two implementations of one fact
/// is already one too many; the risk is that a field is added to one of them and the answer then depends on which caller
/// asked. `Hint` was exactly that: the journal held it, one projection read it, and a failed `for_each` pass stated its
/// per-reason counts to nobody.
/// </para>
/// <para>
/// The population is every reason field a node can carry, on a node that carries all of them at once - so a field added to
/// `BodyProgramJournalNode` and projected by only one side fails here by name once it is wired in.
/// </para>
/// </summary>
[Fact]
public void TheSessionProjectionAndTheProtocolProjectionAnswerTheSameNode()
{
    var snapshot = new BodyProgramStatusSnapshot("program_1", BodyProgramState.RecoveryRequired, 7, 2, 11,
        new[]
        {
            new BodyProgramJournalNode("n01", BodyProgramNodeState.Failed, 3, 4, null, null,
                FailureCode: "shop_counter_out_of_reach", Hint: "closest=4,19", RefusalDetail: "owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1"),
            new BodyProgramJournalNode("n02", BodyProgramNodeState.Rejected, 3, 4, null, null, RejectionCode: "policy_denied"),
            new BodyProgramJournalNode("n03", BodyProgramNodeState.RecoveryRequired, 3, 4, null, null, RecoveryDiagnostic: "execution_uncertain"),
            new BodyProgramJournalNode("n04", BodyProgramNodeState.Succeeded, 3, 4, null, null),
        },
        new[]
        {
            new BodyProgramNodeWork("n01", "shop_purchase", null, null),
            new BodyProgramNodeWork("n02", "plant_seed", 4, 7),
            new BodyProgramNodeWork("n03", "till_soil", 5, 7),
            new BodyProgramNodeWork("n04", "water_crop", 6, 7),
        });

    BridgeBodyProgramStatusSnapshot session = BridgeSession.ToBridgeSnapshot(snapshot)!;
    BridgeBodyProgramStatusSnapshot protocol = BridgeProtocol
        .ProjectBodyProgramStatusResult(new BodyProgramStatusResult(BodyProgramQueryCode.Found, snapshot)).Snapshot!;

    protocol.Should().BeEquivalentTo(session, "two projections of one journal must be one answer");
    protocol.Nodes.Should().HaveCount(4);
    protocol.Nodes.Select(node => node.RefusalDetail).Should().Equal(
        "owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1", null, null, null);
    protocol.Nodes.Select(node => node.RecoveryDiagnostic).Should().Equal(null, null, "execution_uncertain", null);
    }
}
