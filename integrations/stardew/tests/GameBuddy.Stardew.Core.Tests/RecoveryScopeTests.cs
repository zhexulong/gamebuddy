using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A node whose outcome could not be confirmed stops THAT program. It must not stop the save.
///
/// Measured 2026-10-26 on a real run: one `pickup_item` node settled uncertain, the journal went
/// `RecoveryRequired`, and every later submission - including the `advance_day` the companion needed to
/// end its day - came back `quarantined`. The companion could not end its day OR do anything else, so the
/// night never began and the run burned to its timeout.
///
/// The scope of an unknown is the smallest thing that can contain it. A neighbouring program has no
/// unknown dispatch and no claim on the failed program's resources, so refusing it protects nothing.
///
/// These cases pin the boundary from both sides, because a fix that simply admitted everything during
/// recovery would be worse than the defect: an unwritable journal has nowhere to put a new program, so
/// accepting one there would promise a durability that does not exist.
/// </summary>
public sealed class RecoveryScopeTests
{
    [Fact]
    public void AProgramThatSettledUncertainDoesNotBlockADifferentProgram()
    {
        var store = new MemoryStore();
        long now = 10;
        OpenBodyProgramJournalAuthority authority = Open(store, () => now);
        SubmitAndBindFirstNode(authority, "first");
        SettleUncertain(authority);
        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);

        // One tick later: far inside the abandonment bound, so the unknown really is still unknown.
        now += 1;
        BodyProgramSubmitResult fresh = authority.Submit(Program("second"));

        fresh.Code.Should().Be(BodyProgramSubmitCode.Accepted, "a neighbour's unknown is not this program's problem");
        authority.Snapshot.Programs.Should().HaveCount(2);
        authority.Snapshot.Programs.Single(p => p.Program.ProgramId == "second").State
            .Should().Be(BodyProgramState.Active);
    }

    [Fact]
    public void ARecoveringNeighbourDoesNotStopTheFreshProgramsNodesFromBeingAdmitted()
    {
        // The submit half of this was fixed and shipped, and it was HALF a fix. Measured 2026-10-27: a plan was
        // admitted (`Accepted`) and then all five of its nodes stayed `Pending` because `TryCreateAdmissionChallenge`
        // began with `if (!IsMutable) return RecoveryRequired` - a JOURNAL-wide answer to a PROGRAM-wide question.
        // The companion stood in the farmhouse holding an active program it could not start, while the model
        // re-observed and waited with `waitMs: 20000`.
        //
        // Admission is per program. A neighbour's unknown dispatch has nothing to say about these nodes.
        var store = new MemoryStore();
        long now = 10;
        OpenBodyProgramJournalAuthority authority = Open(store, () => now);
        SubmitAndBindFirstNode(authority, "first");
        SettleUncertain(authority);
        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);

        authority.Submit(Program("second")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        BodyProgramControllerResult<NodeAdmissionChallenge> challenge = authority.TryCreateAdmissionChallenge("second");

        challenge.Code.Should().Be(BodyProgramControllerResultCode.Succeeded,
            "the fresh program has nothing to do with the neighbour's unknown dispatch");
        challenge.Value.Should().NotBeNull();

        // And the program that IS in recovery still gets nothing: its unknown node is the thing that must not run.
        authority.TryCreateAdmissionChallenge("first").Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        // The journal still says it is holding an unknown dispatch. Admitting a neighbour does not launder it.
        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
    }

    [Fact]
    public void TheProgramInRecoveryStaysInRecoveryAndIsNotSettled()
    {
        var store = new MemoryStore();
        long now = 10;
        OpenBodyProgramJournalAuthority authority = Open(store, () => now);
        SubmitAndBindFirstNode(authority, "first");
        SettleUncertain(authority);

        now += 1;
        authority.Submit(Program("second")).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        // Admitting a neighbour must not launder the unknown: the whole point of the state is that the
        // effect may or may not exist, and nothing here can say which.
        BodyProgramJournalProgram first = authority.Snapshot.Programs.Single(p => p.Program.ProgramId == "first");
        first.State.Should().Be(BodyProgramState.RecoveryRequired);
        first.Nodes.Single(n => n.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired,
            "the journal still holds an unknown dispatch and must keep saying so");
    }

    [Fact]
    public void AJournalThatCannotBeWrittenStillRefusesEverything()
    {
        // The other side of the boundary. A corrupt or unwritable journal has nowhere to put a new program;
        // accepting one would promise a durability that does not exist.
        var store = new MemoryStore { FailWrites = true };
        OpenBodyProgramJournalAuthority authority = Open(store, () => 10);

        authority.Submit(Program("anything")).Code.Should().Be(BodyProgramSubmitCode.PersistenceFailure);
    }

    [Fact]
    public void ACorruptJournalStillRefusesEverything()
    {
        var store = new MemoryStore();
        store.Set("{ not valid journal json");
        OpenBodyProgramJournalAuthority authority = Open(store, () => 10);
        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);

        authority.Submit(Program("anything")).Code.Should().Be(BodyProgramSubmitCode.Quarantined);
    }

    private static void SubmitAndBindFirstNode(OpenBodyProgramJournalAuthority authority, string programId)
    {
        authority.Submit(Program(programId)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge(programId).Value!;
        HostAdmissionGrant grant = authority.TryConsumeHostGrant(GrantFor(challenge)).Value!;
        authority.TryBeginNativeDispatch(grant, ExecutionFor(grant)).IsSuccess.Should().BeTrue();
    }

    private static void SettleUncertain(OpenBodyProgramJournalAuthority authority)
    {
        HostAdmissionGrant grant = authority.Snapshot.Programs
            .Single(program => program.State == BodyProgramState.Active)
            .Nodes.Single(node => node.State == BodyProgramNodeState.Running)
            .ExecutionBinding is null
            ? throw new System.InvalidOperationException("no bound node to settle")
            : LastBoundGrant;
        authority.TryComplete(grant, new BodyProgramTerminalResult(
            grant.ExecutionBinding!,
            BodyProgramNodeOutcome.Uncertain,
            System.Array.Empty<RuntimeFact>(),
            null,
            null,
            null)).IsSuccess.Should().BeTrue();
    }

    private static HostAdmissionGrant LastBoundGrant { get; set; } = null!;

    private static NodeExecutionBinding ExecutionFor(HostAdmissionGrant grant)
    {
        LastBoundGrant = grant;
        return grant.ExecutionBinding!;
    }

    private static HostAdmissionGrant GrantFor(NodeAdmissionChallenge challenge) => new(
        challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch,
        challenge.CatalogRevision, challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments,
        challenge.DerivedResourceClaims, challenge.DeadlineMs, $"grant-{challenge.NodeId}-{challenge.NodeAttempt}",
        "attachment_01", "host-policy_01");

    private static OpenBodyProgramJournalAuthority Open(MemoryStore store, System.Func<long> now) =>
        OpenBodyProgramJournalAuthority.Open(store, Catalog(), Scope(), () => Policy(), now);

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("machine_inspect", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("expectedTargetId", BodyProgramArgumentKind.String) },
            new[] { new BodyProgramFactDescriptor("machine_target_id", BodyProgramArgumentKind.String) },
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 60_000),
    });

    private static ActionProgramCandidate Program(string programId) => new(programId, new[]
    {
        new ActionProgramCandidateNode("inspect", "machine_inspect",
            new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(
                new Dictionary<string, BodyProgramRuntimeValue>(System.StringComparer.Ordinal)
                {
                    ["x"] = new("integer", "1"),
                    ["y"] = new("integer", "1"),
                    ["expectedTargetId"] = new("string", "target|1"),
                }),
            System.Array.Empty<string>(),
            new ReadOnlyDictionary<string, ActionProgramBinding>(
                new Dictionary<string, ActionProgramBinding>(System.StringComparer.Ordinal))),
    });

    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        private string? value;
        internal bool FailWrites { get; init; }
        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);
        public bool TryWrite(string encodedState)
        {
            if (this.FailWrites) return false;
            this.value = encodedState;
            return true;
        }
        internal void Set(string next) => this.value = next;
    }
}
