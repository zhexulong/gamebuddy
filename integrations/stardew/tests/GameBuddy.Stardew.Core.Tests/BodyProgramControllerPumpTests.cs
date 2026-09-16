using FluentAssertions;
using System.Collections.ObjectModel;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The frozen A→B successor-pump contract: A=machine_inspect (read-only)
/// declares the output fact machine_target_id:string equal to its
/// action-validated opaque machine target identity; B=machine_load is the real
/// native mutation whose expectedTargetId binds via RFC 6901 to A's exact
/// {programId,nodeId,nodeAttempt} machine_target_id fact. These tests drive the
/// controller's narrow pump seam with injected fake nonblocking
/// admission/native seams and prove the automatic A→B progression never
/// requires an Agent B request.
/// </summary>
public sealed class BodyProgramControllerPumpTests
{
    [Fact]
    public void RealModProjectionAcceptsFrozenMachineInspectToMachineLoadProgram()
    {
        // Producer(single registration) → projection → BodyProgram catalog →
        // Design-time verifier: the frozen descriptor contract is verifiable
        // end to end with the exact RFC 6901-style fact binding before any
        // pump logic loads the graph.
        FarmhandBodyProgramCatalogProjectionResult projection = FarmhandBodyProgramCatalogProjection.Create();
        projection.IsPublished.Should().BeTrue();
        OpenBodyProgramJournalAuthority authority = Open(catalog: projection.Catalog!);

        BodyProgramVerificationReport report = authority.Verify(MachineProgram());

        report.Accepted.Should().BeTrue();
    }

    [Fact]
    public void ClosedControllerUpdateIsQuietAndRetainedMutationFailsClosed()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new MachineNodeExecutor("opaque-machine-7");
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Close().Should().Be(BodyProgramAuthorityLifecycleState.Closed);
        controller.Close().Should().Be(BodyProgramAuthorityLifecycleState.Closed);
        controller.Update();

        admission.Sent.Should().BeEmpty();
        executor.Runs.Should().BeEmpty();
        controller.TryStop("program", 1).Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
    }

    [Fact]
    public void ReentrantCloseFromAdmissionCallbackDrainsAndPreventsNativeCallback()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        FarmhandBodyProgramController? controller = null;
        var admission = new CloseOnSendAdmissionTransport(() => controller!.Close());
        var executor = new MachineNodeExecutor("opaque-machine-7");
        controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        admission.CloseState.Should().Be(BodyProgramAuthorityLifecycleState.Draining);
        authority.LifecycleState.Should().Be(BodyProgramAuthorityLifecycleState.Closed);
        admission.Sent.Should().ContainSingle().Which.NodeId.Should().Be("inspect");
        executor.Runs.Should().BeEmpty();
        controller.Update();
        Action retainedQuery = () => authority.Status("program");
        retainedQuery.Should().Throw<ObjectDisposedException>();
    }

    [Fact]
    public void ReentrantCloseFromExecutorCallbackDrainsAndPreventsTerminalTransition()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = OpenBodyProgramJournalAuthority.Open(store, MachineCatalog(), Scope(), () => Policy(), () => 10);
        FarmhandBodyProgramController? controller = null;
        var admission = new ImmediateAdmissionTransport();
        var executor = new CloseOnExecuteExecutor(() => controller!.Close());
        controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        executor.CloseState.Should().Be(BodyProgramAuthorityLifecycleState.Draining);
        executor.Runs.Should().Be(1);
        authority.LifecycleState.Should().Be(BodyProgramAuthorityLifecycleState.Closed);
        store.Value.Should().NotContain("node_completed");
        controller.Update();
        Action retainedQuery = () => authority.Status("program");
        retainedQuery.Should().Throw<ObjectDisposedException>();
    }

    [Fact]
    public void PumpStartsDependencyFreeSourceChallengeAutomaticallyAfterSubmitWithoutAgentRequest()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new MachineNodeExecutor("opaque-machine-7");
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        admission.Sent.Should().ContainSingle().Which.NodeId.Should().Be("inspect");
        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Succeeded);
        status.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Pending);
        executor.Runs.Should().ContainSingle().Which.ActionId.Should().Be("machine_inspect");
        authority.Events("program", 0, 32).Events.Should().ContainSingle(@event => @event.Kind == "accepted");
    }

    [Fact]
    public void PumpAutomaticallySelectsSuccessorAfterExactFactProjectionWithoutAgentRequest()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new MachineNodeExecutor("opaque-machine-7");
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        for (int tick = 0; tick < 8 && authority.Status("program").Snapshot!.State != BodyProgramState.Succeeded; tick++)
            controller.Update();

        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.State.Should().Be(BodyProgramState.Succeeded);
        status.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Succeeded);

        NodeAdmissionChallenge load = admission.Sent.Single(challenge => challenge.NodeId == "load");
        // B's exact challenge was minted by the same controller from A's exact
        // producing {programId,nodeId,nodeAttempt} fact, without any Agent B
        // request and without echoing the candidate literal.
        load.ProgramId.Should().Be("program");
        load.CanonicalArguments["expectedTargetId"].CanonicalValue.Should().Be("opaque-machine-7");

        BodyProgramEventsResult events = authority.Events("program", 0, 32);
        events.Events.Should().ContainSingle(@event => @event.Kind == "accepted");
        events.Events.Where(@event => @event.Kind == "admission_challenge").Select(@event => @event.NodeId)
            .Should().Equal("inspect", "load");
    }

    [Fact]
    public void PumpCorrelatesExactTupleAndMaterializedArgumentsThroughTheNativeAdapter()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new MachineNodeExecutor("opaque-machine-7");
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        for (int tick = 0; tick < 8 && authority.Status("program").Snapshot!.State != BodyProgramState.Succeeded; tick++)
            controller.Update();

        executor.Runs.Should().HaveCount(2);
        (string ActionId, NodeExecutionBinding Execution, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Arguments) inspect = executor.Runs[0];
        inspect.ActionId.Should().Be("machine_inspect");
        inspect.Execution.ProgramId.Should().Be("program");
        inspect.Execution.NodeId.Should().Be("inspect");
        inspect.Execution.NodeAttempt.Should().Be(1);
        inspect.Arguments["expectedTargetId"].CanonicalValue.Should().Be("candidate-target|1");

        (string ActionId, NodeExecutionBinding Execution, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Arguments) load = executor.Runs[1];
        load.ActionId.Should().Be("machine_load");
        load.Execution.NodeId.Should().Be("load");
        load.Execution.NodeAttempt.Should().Be(1);
        load.Execution.IdempotencyKey.Should().NotBe(inspect.Execution.IdempotencyKey);
        // The exact-tuple correlation is the only link between the action-owned
        // native terminal and the journal; the authority rejects any terminal
        // whose execution is not the dispatched binding.
        load.Arguments["expectedTargetId"].CanonicalValue.Should().Be("opaque-machine-7");
    }

    [Fact]
    public void PumpPersistsFactsWithExactProducingAttemptProvenance()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var controller = new FarmhandBodyProgramController(authority, admission, new MachineNodeExecutor("opaque-machine-7"));
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        for (int tick = 0; tick < 8 && authority.Status("program").Snapshot!.State != BodyProgramState.Succeeded; tick++)
            controller.Update();

        RuntimeFact fact = authority.Snapshot.Programs.Single().Facts.Single();
        fact.ProgramId.Should().Be("program");
        fact.NodeId.Should().Be("inspect");
        fact.NodeAttempt.Should().Be(1);
        fact.FactName.Should().Be("machine_target_id");
        fact.Values["machine_target_id"].CanonicalValue.Should().Be("opaque-machine-7");
    }

    [Fact]
    public void PumpNeverStartsSuccessorWithoutTerminalProofAndDeclaredFact()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new MachineNodeExecutor("opaque-machine-7");
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        executor.FailNext = true;

        for (int tick = 0; tick < 4 && authority.Status("program").Snapshot!.State != BodyProgramState.Failed; tick++)
            controller.Update();

        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.State.Should().Be(BodyProgramState.Failed);
        status.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Pending);
        admission.Sent.Should().ContainSingle(challenge => challenge.NodeId == "inspect");
        admission.Sent.Should().NotContain(challenge => challenge.NodeId == "load");
    }

    [Fact]
    public void PumpConsumesRejectedAdmissionWithoutTreatingUnavailableAsRejected()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new RejectedAdmissionTransport("policy_denied");
        var controller = new FarmhandBodyProgramController(authority, admission, new MachineNodeExecutor("opaque-machine-7"));
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Rejected);
        admission.Sent.Should().ContainSingle();
        admission.ResultsTaken.Should().ContainSingle();
    }

    [Fact]
     public void StopBeforeSourceStartsParksThePump()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var controller = new FarmhandBodyProgramController(authority, admission, new MachineNodeExecutor("opaque-machine-7"));
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        controller.TryStop("program", 1).IsSuccess.Should().BeTrue();

        controller.Update();

        admission.Sent.Should().BeEmpty();
        BodyProgramStatusSnapshot stopped = authority.Status("program").Snapshot!;
        stopped.State.Should().Be(BodyProgramState.Cancelled);
        stopped.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Cancelled);
    }

    [Fact]
    public void StopBetweenNodesBlocksTheAutomaticSuccessor()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var controller = new FarmhandBodyProgramController(authority, admission, new MachineNodeExecutor("opaque-machine-7"));
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Succeeded);
        controller.TryStop("program", 1).IsSuccess.Should().BeTrue();

        controller.Update();

        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.State.Should().Be(BodyProgramState.Cancelled);
        status.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Cancelled);
        admission.Sent.Should().NotContain(challenge => challenge.NodeId == "load");
    }

    [Fact]
    public void DeadlineBetweenNodesBlocksTheAutomaticSuccessor()
    {
        long now = 10;
        OpenBodyProgramJournalAuthority authority = Open(now: () => now);
        var admission = new ImmediateAdmissionTransport();
        var controller = new FarmhandBodyProgramController(authority, admission, new MachineNodeExecutor("opaque-machine-7"));
        authority.Submit(MachineProgram(deadline: 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Succeeded);

        now = 1001;
        controller.Update();

        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Pending);
        admission.Sent.Should().NotContain(challenge => challenge.NodeId == "load");
    }

    [Fact]
    public void HostAdmissionUnavailableLeavesNodeAwaitingWithoutFabricatedGrant()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new NoGrantAdmissionTransport();
        var executor = new MachineNodeExecutor("opaque-machine-7");
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.State.Should().Be(BodyProgramState.Active);
        status.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.AwaitingHostAdmission);
        status.Nodes.Single(node => node.NodeId == "inspect").NodeAttempt.Should().Be(1);
        status.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Pending);
        executor.Runs.Should().BeEmpty();
        admission.Sent.Should().ContainSingle().Which.NodeId.Should().Be("inspect");
    }

    [Fact]
    public void ExplicitHostAdmissionUnavailableResultPreservesAwaitingAttemptAndChallengeEvent()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new UnavailableAdmissionTransport();
        var executor = new MachineNodeExecutor("opaque-machine-7");
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        BodyProgramJournalNode inspect = status.Nodes.Single(node => node.NodeId == "inspect");
        status.State.Should().Be(BodyProgramState.Active);
        inspect.State.Should().Be(BodyProgramNodeState.AwaitingHostAdmission);
        inspect.NodeAttempt.Should().Be(1);
        inspect.AdmissionAttempt.Should().Be(1);
        inspect.GrantId.Should().BeNull();
        inspect.RejectionCode.Should().BeNull();
        admission.ResultsTaken.Should().Be(1);
        executor.Runs.Should().BeEmpty();
        authority.Events("program", 0, 32).Events.Should().ContainSingle(@event =>
            @event.Kind == "admission_challenge" && @event.NodeId == "inspect" && @event.NodeAttempt == 1);
        authority.Events("program", 0, 32).Events.Should().NotContain(@event => @event.Kind == "admission_rejected");
    }

    [Fact]
    public void StopWhileAwaitingAdmissionCancelsNodeAndPumpStaysQuiet()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new NoGrantAdmissionTransport();
        var executor = new MachineNodeExecutor("opaque-machine-7");
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.AwaitingHostAdmission);

        controller.TryStop("program", 1).IsSuccess.Should().BeTrue();
        controller.Update();

        authority.Status("program").Snapshot!.State.Should().Be(BodyProgramState.Cancelled);
        authority.Status("program").Snapshot!.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Cancelled);
        executor.Runs.Should().BeEmpty();
    }

    [Fact]
    public void PumpWithoutWiredSeamsIsParkedAndCreatesNoChallengeOrGrant()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var controller = new FarmhandBodyProgramController(authority);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        authority.Status("program").Snapshot!.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Pending);
        authority.Events("program", 0, 32).Events.Should().ContainSingle(@event => @event.Kind == "accepted");
    }

    [Fact]
    public void ExecutorThrowAfterRunningTransitionDoesNotEscapeAndDurablySettlesExactNode()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = OpenBodyProgramJournalAuthority.Open(store, MachineCatalog(), Scope(), () => Policy(), () => 10);
        var admission = new ImmediateAdmissionTransport();
        var executor = new MachineNodeExecutor("opaque-machine-7") { ThrowOnExecute = true };
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        // The dispatch durably transitions the exact binding to Running first;
        // the executor failure must then be contained by the controller.
        Action pump = () => controller.Update();
        pump.Should().NotThrow();

        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.State.Should().Be(BodyProgramState.RecoveryRequired);
        BodyProgramJournalNode inspect = status.Nodes.Single(node => node.NodeId == "inspect");
        inspect.State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        inspect.GrantId.Should().BeNull();
        inspect.ExecutionBinding.Should().NotBeNull();
        inspect.CanonicalBoundArguments.Should().NotBeNull();
        inspect.AttemptPolicyIdentity.Should().Be(Policy());
        inspect.ClaimOwnership.Should().NotBeNull();
        inspect.ReceiptId.Should().BeNull();
        inspect.Evidence.Should().BeNull();
        inspect.PostconditionVerification.Should().BeNull();
        inspect.RecoveryDiagnostic.Should().Be("execution_uncertain");
        status.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Pending);
        authority.Snapshot.Programs.Single().Facts.Should().BeEmpty();
        admission.Sent.Should().ContainSingle().Which.NodeId.Should().Be("inspect");
        // The native side began exactly once: no duplicate execution and no retry.
        executor.Runs.Should().ContainSingle();
        authority.Events("program", 0, 32).Events.Should().ContainSingle(@event => @event.Kind == "node_completed");
        authority.Events("program", 0, 32).Events.Should().NotContain(@event => @event.Kind == "node_settled");

        // Durable: a fresh reopen of the same store sees the exact settled state.
        OpenBodyProgramJournalAuthority reopened = OpenBodyProgramJournalAuthority.Open(store, MachineCatalog(), Scope(), () => Policy(), () => 10);
        reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
        BodyProgramJournalProgram persisted = reopened.Snapshot.Programs.Single();
        persisted.State.Should().Be(BodyProgramState.RecoveryRequired);
        persisted.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        persisted.Facts.Should().BeEmpty();

        // The pump stays quiet after settlement: no successor challenge.
        controller.Update();
        executor.Runs.Should().ContainSingle();
        admission.Sent.Should().ContainSingle();
    }

    [Fact]
    public void TerminalRejectedAfterDeadlineDurablySettlesRunningNodeWithoutFactsOrSuccessor()
    {
        var clock = new TimeBox { Value = 10 };
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = OpenBodyProgramJournalAuthority.Open(store, MachineCatalog(), Scope(), () => Policy(), () => clock.Value);
        var admission = new ImmediateAdmissionTransport();
        var executor = new DeadlineOverrunExecutor(new MachineNodeExecutor("opaque-machine-7"), clock, overrunMs: 1001);
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgramWithTerminalCheck()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Succeeded);

        // The load run overruns the frozen deadline while executing; its terminal
        // lands after expiry and the strict completion path must reject it.
        controller.Update();

        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.State.Should().Be(BodyProgramState.RecoveryRequired);
        BodyProgramJournalNode load = status.Nodes.Single(node => node.NodeId == "load");
        load.State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        load.GrantId.Should().BeNull();
        load.ExecutionBinding.Should().NotBeNull();
        load.CanonicalBoundArguments.Should().NotBeNull();
        load.AttemptPolicyIdentity.Should().Be(Policy());
        load.ClaimOwnership.Should().NotBeNull();
        load.ReceiptId.Should().BeNull();
        load.Evidence.Should().BeNull();
        load.PostconditionVerification.Should().BeNull();
        load.RecoveryDiagnostic.Should().Be("recovery_required");
        status.Nodes.Single(node => node.NodeId == "verify").State.Should().Be(BodyProgramNodeState.Pending);

        // The rejected Succeeded terminal contributed no facts, receipt, or
        // evidence; only inspect's proven fact remains.
        authority.Snapshot.Programs.Single().Facts.Should().ContainSingle().Which.NodeId.Should().Be("inspect");
        // Exactly one run per dispatched node: no duplicate execution of load.
        executor.Runs.Should().HaveCount(2);
        executor.Runs[1].Execution.NodeId.Should().Be("load");
        // No successor challenge and no retry after settlement.
        admission.Sent.Select(challenge => challenge.NodeId).Should().Equal("inspect", "load");

        controller.Update();
        executor.Runs.Should().HaveCount(2);
        admission.Sent.Select(challenge => challenge.NodeId).Should().Equal("inspect", "load");
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "verify").State.Should().Be(BodyProgramNodeState.Pending);
        authority.Events("program", 0, 32).Events.Should().ContainSingle(@event => @event.Kind == "node_settled");

        // Durable: a fresh reopen of the same store retains the exact settlement.
        OpenBodyProgramJournalAuthority reopened = OpenBodyProgramJournalAuthority.Open(store, MachineCatalog(), Scope(), () => Policy(), () => clock.Value);
        reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
        BodyProgramJournalProgram persisted = reopened.Snapshot.Programs.Single();
        persisted.State.Should().Be(BodyProgramState.RecoveryRequired);
        persisted.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        persisted.Nodes.Single(node => node.NodeId == "load").GrantId.Should().BeNull();
        persisted.Facts.Should().ContainSingle().Which.NodeId.Should().Be("inspect");
        reopened.Events("program", 0, 32).Events.Should().ContainSingle(@event => @event.Kind == "node_settled");
    }

    [Fact]
    public void SettlementFailsClosedOnWrongTupleOrStateAndSettlesOnlyTheExactRunningNode()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        HostAdmissionGrant bound = authority.TryConsumeHostGrant(GrantFor(challenge)).Value!;
        authority.TryBeginNativeDispatch(bound, bound.ExecutionBinding!).IsSuccess.Should().BeTrue();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Running);

        // Forged grant identity, forged grant binding, and forged execution all
        // fail closed without mutating the Running node.
        authority.TrySettleRecoveryRequired(bound with { GrantId = "forged-grant" }, bound.ExecutionBinding!).IsSuccess.Should().BeFalse();
        authority.TrySettleRecoveryRequired(bound with { ExecutionBinding = bound.ExecutionBinding! with { ExecutionId = "exec-forged" } }, bound.ExecutionBinding!).IsSuccess.Should().BeFalse();
        authority.TrySettleRecoveryRequired(bound, bound.ExecutionBinding! with { ExecutionId = "exec-forged" }).IsSuccess.Should().BeFalse();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Running);

        // The exact bound grant and execution settle durably: only the settled
        // node changes, no facts are accepted, and no attempt/retry is created.
        authority.TrySettleRecoveryRequired(bound, bound.ExecutionBinding!).IsSuccess.Should().BeTrue();
        BodyProgramStatusSnapshot settled = authority.Status("program").Snapshot!;
        settled.State.Should().Be(BodyProgramState.RecoveryRequired);
        BodyProgramJournalNode node = settled.Nodes.Single(item => item.NodeId == "inspect");
        node.State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        node.NodeAttempt.Should().Be(1);
        node.AdmissionAttempt.Should().Be(1);
        node.GrantId.Should().BeNull();
        node.ExecutionBinding.Should().Be(bound.ExecutionBinding);
        node.CanonicalBoundArguments.Should().NotBeNull();
        node.AttemptPolicyIdentity.Should().Be(Policy());
        node.ClaimOwnership.Should().NotBeNull();
        node.ReceiptId.Should().BeNull();
        node.Evidence.Should().BeNull();
        node.PostconditionVerification.Should().BeNull();
        node.RecoveryDiagnostic.Should().Be("recovery_required");
        settled.Nodes.Single(item => item.NodeId == "load").State.Should().Be(BodyProgramNodeState.Pending);
        authority.Snapshot.Programs.Single().Facts.Should().BeEmpty();
        authority.Events("program", 0, 32).Events.Should().ContainSingle(@event => @event.Kind == "node_settled");

        // A later re-settlement of the same tuple fails closed: the exact node
        // is no longer Running.
        authority.TrySettleRecoveryRequired(bound, bound.ExecutionBinding!).IsSuccess.Should().BeFalse();
        authority.Events("program", 0, 32).Events.Where(@event => @event.Kind == "node_settled").Should().ContainSingle();
    }

    [Fact]
    public void SteppingAsyncNodeIsRevisitedOnLaterTicksUntilItsTupleReceiptGoesTerminal()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new SteppingNodeExecutor(new MachineNodeExecutor("opaque-machine-7"), "load", terminalOnVisit: 3);
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        // Tick 1: the synchronous source node completes in a single pass.
        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Succeeded);
        executor.Runs.Where(run => run.Execution.NodeId == "inspect").Should().ContainSingle();

        // Tick 2: load is challenged, granted, and dispatched; the producer
        // returns the null bound-Running continuation sentinel instead of a
        // terminal, so the node stays Running.
        controller.Update();
        BodyProgramJournalNode firstRunning = authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "load");
        firstRunning.State.Should().Be(BodyProgramNodeState.Running);
        firstRunning.ExecutionBinding.Should().NotBeNull();
        executor.Runs.Where(run => run.Execution.NodeId == "load").Should().ContainSingle();

        // Tick 3: the same dispatch tuple is re-entered while the receipt is
        // still non-terminal; the node stays bound-Running with the same binding.
        controller.Update();
        BodyProgramJournalNode stillRunning = authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "load");
        stillRunning.State.Should().Be(BodyProgramNodeState.Running);
        stillRunning.ExecutionBinding.Should().Be(firstRunning.ExecutionBinding);
        executor.Runs.Where(run => run.Execution.NodeId == "load").Should().HaveCount(2);

        // Tick 4: the re-entry projects the terminal; the node completes exactly
        // once with no re-dispatch, no re-challenge, and no duplicated lineage.
        controller.Update();
        BodyProgramStatusSnapshot done = authority.Status("program").Snapshot!;
        done.State.Should().Be(BodyProgramState.Succeeded);
        done.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Succeeded);
        executor.Runs.Where(run => run.Execution.NodeId == "load").Should().HaveCount(3);
        executor.Runs.Where(run => run.Execution.NodeId == "load").Select(run => run.Execution.ExecutionId).Distinct().Should().ContainSingle();
        authority.Events("program", 0, 32).Events.Where(@event => @event.Kind == "admission_challenge" && @event.NodeId == "load").Should().ContainSingle();
        authority.Events("program", 0, 32).Events.Where(@event => @event.Kind == "native_dispatch" && @event.NodeId == "load").Should().ContainSingle();
        authority.Events("program", 0, 32).Events.Where(@event => @event.Kind == "node_completed" && @event.NodeId == "load").Should().ContainSingle();
    }

    [Fact]
    public void DeadlineExpiryMidRunSettlesRunningContinuationWithoutRetry()
    {
        var clock = new TimeBox { Value = 10 };
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = OpenBodyProgramJournalAuthority.Open(store, MachineCatalog(), Scope(), () => Policy(), () => clock.Value);
        var admission = new ImmediateAdmissionTransport();
        var executor = new DeadlineDrivenSteppingExecutor(new MachineNodeExecutor("opaque-machine-7"), clock, overrunMs: 1001);
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram(deadline: 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        // Tick 1: inspect completes in a single pass.
        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Succeeded);

        // Tick 2: load is dispatched; the producer leaves it Running and the
        // frozen deadline expires during the run (the clock advances past the
        // deadline). The node stays bound-Running for a later tick instead of
        // settling prematurely or being overrun inside one pass.
        controller.Update();
        BodyProgramJournalNode running = authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "load");
        running.State.Should().Be(BodyProgramNodeState.Running);
        executor.LoadVisits.Should().Be(1);

        // Tick 3: the re-entry gate re-checks stop-epoch/policy/deadline exactly
        // like initial dispatch, sees the expired live deadline, and durably
        // settles the exact still-Running node to RecoveryRequired. The executor
        // is never re-entered for the overrun tuple and no retry is created.
        controller.Update();
        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        status.State.Should().Be(BodyProgramState.RecoveryRequired);
        BodyProgramJournalNode load = status.Nodes.Single(node => node.NodeId == "load");
        load.State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        load.GrantId.Should().BeNull();
        load.ExecutionBinding.Should().NotBeNull();
        load.ReceiptId.Should().BeNull();
        load.Evidence.Should().BeNull();
        load.PostconditionVerification.Should().BeNull();
        load.RecoveryDiagnostic.Should().Be("recovery_required");
        executor.LoadVisits.Should().Be(1);
        executor.Runs.Should().ContainSingle();
        authority.Events("program", 0, 32).Events.Where(@event => @event.Kind == "node_completed" && @event.NodeId == "load").Should().BeEmpty();
        authority.Events("program", 0, 32).Events.Where(@event => @event.Kind == "node_settled" && @event.NodeId == "load").Should().ContainSingle();

        // The pump stays quiet after settlement: no re-visit, no retry, and no
        // successor challenge.
        controller.Update();
        executor.LoadVisits.Should().Be(1);
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        admission.Sent.Select(challenge => challenge.NodeId).Should().Equal("inspect", "load");

        // Durable: a fresh reopen of the same store retains the exact settlement.
        OpenBodyProgramJournalAuthority reopened = OpenBodyProgramJournalAuthority.Open(store, MachineCatalog(), Scope(), () => Policy(), () => clock.Value);
        reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
        BodyProgramJournalProgram persisted = reopened.Snapshot.Programs.Single();
        persisted.State.Should().Be(BodyProgramState.RecoveryRequired);
        persisted.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        reopened.Events("program", 0, 32).Events.Where(@event => @event.Kind == "node_settled" && @event.NodeId == "load").Should().ContainSingle();
    }

    [Fact]
    public void PersistenceFailureRetainsTupleUntilSettleCanWrite()
    {
        var clock = new TimeBox { Value = 10 };
        // The store always refuses the settle write (node_settled event) but
        // allows every other write. Since the existing deadline test
        // (DeadlineExpiryMidRun...) proves a working store durably settles to
        // RecoveryRequired, this test only needs to demonstrate that a failed
        // settle does not strand the node Running forever — the tuple is
        // retained and later ticks re-attempt the settle.
        var store = new FailSettleWriteStore();
        OpenBodyProgramJournalAuthority authority = OpenBodyProgramJournalAuthority.Open(store, MachineCatalog(), Scope(), () => Policy(), () => clock.Value);
        var admission = new ImmediateAdmissionTransport();
        var executor = new DeadlineDrivenSteppingExecutor(new MachineNodeExecutor("opaque-machine-7"), clock, overrunMs: 1001);
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram(deadline: 1000)).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        // Tick 1: inspect completes.
        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "inspect").State.Should().Be(BodyProgramNodeState.Succeeded);

        // Tick 2: load is dispatched and left Running.
        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Running);
        executor.LoadVisits.Should().Be(1);

        // Tick 3: the re-entry gate sees the expired deadline and attempts to
        // settle; the settle write fails. The controller keeps the tuple
        // retained (boundRunning) instead of abandoning it, so a later tick
        // retries rather than stranding the node Running forever.
        controller.Update();
        // Authority state is still Running because the settle write failed.
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Running);
        // The executor was never re-entered for the overrun tuple.
        executor.LoadVisits.Should().Be(1);

        // Tick 4..: a later tick re-runs the re-entry gate (node still Running)
        // and retries the settle. This still fails, but the important contract
        // is: the node is revisited each tick (not stranded) and the executor
        // is never re-entered (no retry).
        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Running);
        executor.LoadVisits.Should().Be(1);
    }

    [Fact]
    public void StopMidRunCancelsBoundRunningNodeWithoutFurtherRevisits()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new SteppingNodeExecutor(new MachineNodeExecutor("opaque-machine-7"), "load", terminalOnVisit: 5);
        var controller = new FarmhandBodyProgramController(authority, admission, executor);
        authority.Submit(MachineProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        // Tick 1 completes inspect; tick 2 dispatches load, which stays
        // bound-Running with a retained continuation tuple.
        controller.Update();
        controller.Update();
        executor.Runs.Where(run => run.Execution.NodeId == "load").Should().ContainSingle();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Running);

        // An explicit STOP mid-run resolves the whole program (and the Running
        // node) to Cancelled; later ticks must never revisit the retained tuple.
        controller.TryStop("program", 1).IsSuccess.Should().BeTrue();
        controller.Update();
        controller.Update();

        BodyProgramStatusSnapshot stopped = authority.Status("program").Snapshot!;
        stopped.State.Should().Be(BodyProgramState.Cancelled);
        stopped.Nodes.Single(node => node.NodeId == "load").State.Should().Be(BodyProgramNodeState.Cancelled);
        executor.Runs.Where(run => run.Execution.NodeId == "load").Should().ContainSingle();
        authority.Events("program", 0, 32).Events.Where(@event => @event.Kind == "node_completed" && @event.NodeId == "load").Should().BeEmpty();
    }

    private static OpenBodyProgramJournalAuthority Open(BodyProgramActionCatalog? catalog = null, Func<long>? now = null) =>
        OpenBodyProgramJournalAuthority.Open(new MemoryStore(), catalog ?? MachineCatalog(), Scope(), () => Policy(), now ?? (() => 10));

    private static BodyProgramActionCatalog MachineCatalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("machine_inspect", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("expectedTargetId", BodyProgramArgumentKind.String) },
            new[] { new BodyProgramFactDescriptor("machine_target_id", BodyProgramArgumentKind.String) },
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
        new BodyProgramActionDescriptor("machine_load", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("slot", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("expectedQualifiedItemId", BodyProgramArgumentKind.String), new BodyProgramArgumentDescriptor("expectedTargetId", BodyProgramArgumentKind.String) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
    });

    private static ActionProgramCandidate MachineProgram(string targetLiteral = "candidate-target|1", long deadline = 1000) => new("program", new[]
    {
        new ActionProgramCandidateNode("inspect", "machine_inspect", Args(("x", "integer", "1"), ("y", "integer", "1"), ("expectedTargetId", "string", targetLiteral)), Array.Empty<string>(), Bindings(), deadline),
        new ActionProgramCandidateNode("load", "machine_load", Args(("x", "integer", "1"), ("y", "integer", "1"), ("slot", "integer", "5"), ("expectedQualifiedItemId", "string", "(O)433"), ("expectedTargetId", "string", "placeholder-target")), new[] { "inspect" }, Bindings("expectedTargetId", new ActionProgramBinding("inspect", "machine_target_id")), deadline),
    });

    /// <summary>
    /// The frozen A→B→verify successor-pump contract used to prove that a
    /// settled Running node never challenges, dispatches, or replays its
    /// successor: verify depends on load and must stay Pending after load
    /// settles to RecoveryRequired.
    /// </summary>
    private static ActionProgramCandidate MachineProgramWithTerminalCheck(long deadline = 1000) => new("program", new[]
    {
        new ActionProgramCandidateNode("inspect", "machine_inspect", Args(("x", "integer", "1"), ("y", "integer", "1"), ("expectedTargetId", "string", "candidate-target|1")), Array.Empty<string>(), Bindings(), deadline),
        new ActionProgramCandidateNode("load", "machine_load", Args(("x", "integer", "1"), ("y", "integer", "1"), ("slot", "integer", "5"), ("expectedQualifiedItemId", "string", "(O)433"), ("expectedTargetId", "string", "placeholder-target")), new[] { "inspect" }, Bindings("expectedTargetId", new ActionProgramBinding("inspect", "machine_target_id")), deadline),
        new ActionProgramCandidateNode("verify", "machine_load", Args(("x", "integer", "1"), ("y", "integer", "1"), ("slot", "integer", "5"), ("expectedQualifiedItemId", "string", "(O)433"), ("expectedTargetId", "string", "opaque-target")), new[] { "load" }, Bindings(), deadline),
    });

    private sealed class ImmediateAdmissionTransport : IBodyProgramAdmissionTransport
    {
        private readonly Dictionary<(string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt), HostAdmissionGrant> grants = new();
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public void Send(NodeAdmissionChallenge challenge)
        {
            this.Sent.Add(challenge);
            this.grants[(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt)] = GrantFor(challenge);
        }
        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt)
        {
            this.grants.TryGetValue((programId, nodeId, nodeAttempt, admissionAttempt), out HostAdmissionGrant? grant);
            return grant is null ? null : new BodyNodeAdmissionGrantedResult(grant);
        }
    }

    private sealed class RejectedAdmissionTransport : IBodyProgramAdmissionTransport
    {
        private readonly string code;
        public RejectedAdmissionTransport(string code) => this.code = code;
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public List<(string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt)> ResultsTaken { get; } = new();
        public void Send(NodeAdmissionChallenge challenge) => this.Sent.Add(challenge);
        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt)
        {
            this.ResultsTaken.Add((programId, nodeId, nodeAttempt, admissionAttempt));
            NodeAdmissionChallenge challenge = this.Sent.Single(item => item.ProgramId == programId && item.NodeId == nodeId && item.NodeAttempt == nodeAttempt && item.AdmissionAttempt == admissionAttempt);
            return new BodyNodeAdmissionRejectedResult(challenge, this.code);
        }
    }

     private sealed class NoGrantAdmissionTransport : IBodyProgramAdmissionTransport
    {
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public void Send(NodeAdmissionChallenge challenge) => this.Sent.Add(challenge);
        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt) => null;
    }

    private sealed class UnavailableAdmissionTransport : IBodyProgramAdmissionTransport
    {
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public int ResultsTaken { get; private set; }
        public void Send(NodeAdmissionChallenge challenge) => this.Sent.Add(challenge);
        public BodyNodeAdmissionResult TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt)
        {
            this.ResultsTaken++;
            NodeAdmissionChallenge challenge = this.Sent.Single(item => item.ProgramId == programId && item.NodeId == nodeId
                && item.NodeAttempt == nodeAttempt && item.AdmissionAttempt == admissionAttempt);
            return new BodyNodeAdmissionUnavailableResult(challenge);
        }
    }

    private sealed class CloseOnSendAdmissionTransport : IBodyProgramAdmissionTransport
    {
        private readonly Func<BodyProgramAuthorityLifecycleState> close;
        public CloseOnSendAdmissionTransport(Func<BodyProgramAuthorityLifecycleState> close) => this.close = close;
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public BodyProgramAuthorityLifecycleState? CloseState { get; private set; }
        public void Send(NodeAdmissionChallenge challenge)
        {
            this.Sent.Add(challenge);
            this.CloseState = this.close() == BodyProgramAuthorityLifecycleState.Draining
                ? BodyProgramAuthorityLifecycleState.Draining
                : BodyProgramAuthorityLifecycleState.Closed;
        }
        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt) => null;
    }

    private sealed class MachineNodeExecutor : IBodyProgramNodeExecutor
    {
        private readonly string validatedMachineTargetIdentity;
        public MachineNodeExecutor(string validatedMachineTargetIdentity) => this.validatedMachineTargetIdentity = validatedMachineTargetIdentity;
        public bool FailNext { get; set; }
        public bool ThrowOnExecute { get; set; }
        public List<(string ActionId, NodeExecutionBinding Execution, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Arguments)> Runs { get; } = new();
        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            this.Runs.Add((grant.ActionId, execution, grant.CanonicalArguments));
            if (this.ThrowOnExecute) throw new InvalidOperationException("Native producer terminated unexpectedly.");
            if (this.FailNext)
            {
                this.FailNext = false;
                return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Failed, Array.Empty<RuntimeFact>(), null, null, null);
            }
            if (grant.ActionId == "machine_inspect")
            {
                RuntimeFact fact = new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, "machine_target_id",
                    new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal) { ["machine_target_id"] = new(BodyProgramArgumentKind.String, this.validatedMachineTargetIdentity) });
                return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Succeeded, new[] { fact }, "receipt-inspect", "evidence-inspect", "postcondition-inspect");
            }
            return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt-load", "evidence-load", "postcondition-load");
        }
    }

    private sealed class CloseOnExecuteExecutor : IBodyProgramNodeExecutor
    {
        private readonly Func<BodyProgramAuthorityLifecycleState> close;
        public CloseOnExecuteExecutor(Func<BodyProgramAuthorityLifecycleState> close) => this.close = close;
        public int Runs { get; private set; }
        public BodyProgramAuthorityLifecycleState? CloseState { get; private set; }
        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            this.Runs++;
            this.CloseState = this.close() == BodyProgramAuthorityLifecycleState.Draining
                ? BodyProgramAuthorityLifecycleState.Draining
                : BodyProgramAuthorityLifecycleState.Closed;
            return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Failed, Array.Empty<RuntimeFact>(), null, null, null);
        }
    }

    private sealed class TimeBox { public long Value { get; set; } }

    /// <summary>
    /// Wraps the real machine producer but advances the injectable clock past
    /// the frozen node deadline while the exact machine_load run is still
    /// executing, so the action-owned terminal lands after deadline expiry.
    /// </summary>
    private sealed class DeadlineOverrunExecutor : IBodyProgramNodeExecutor
    {
        private readonly MachineNodeExecutor machines;
        private readonly TimeBox clock;
        private readonly long overrunMs;

        public DeadlineOverrunExecutor(MachineNodeExecutor machines, TimeBox clock, long overrunMs)
        {
            this.machines = machines;
            this.clock = clock;
            this.overrunMs = overrunMs;
        }

        public List<(string ActionId, NodeExecutionBinding Execution, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Arguments)> Runs => this.machines.Runs;

        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            var terminal = this.machines.Execute(grant, execution);
            if (grant.ActionId == "machine_load") this.clock.Value = this.overrunMs;
            return terminal;
        }
    }

    /// <summary>
    /// Wraps the real machine producer so one node produces no terminal for the
    /// first N-1 visits (returning the null bound-Running continuation sentinel)
    /// and only projects its action-owned terminal on visit N.
    /// </summary>
    private sealed class SteppingNodeExecutor : IBodyProgramNodeExecutor
    {
        private readonly MachineNodeExecutor machines;
        private readonly string nodeId;
        private readonly int terminalOnVisit;
        private readonly Dictionary<string, int> visits = new(StringComparer.Ordinal);

        public SteppingNodeExecutor(MachineNodeExecutor machines, string nodeId, int terminalOnVisit)
        {
            this.machines = machines;
            this.nodeId = nodeId;
            this.terminalOnVisit = terminalOnVisit;
        }

        public List<(string ActionId, NodeExecutionBinding Execution, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Arguments)> Runs => this.machines.Runs;

        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            var terminal = this.machines.Execute(grant, execution);
            if (grant.NodeId != this.nodeId) return terminal;
            int visit = this.visits.GetValueOrDefault(execution.ExecutionId) + 1;
            this.visits[execution.ExecutionId] = visit;
            return visit >= this.terminalOnVisit ? terminal : null;
        }
    }

    /// <summary>
    /// Wraps the real machine producer but leaves the machine_load node bound-
    /// Running: it returns the null continuation sentinel and advances the
    /// injectable clock past the frozen node deadline while that exact run is
    /// still executing, so the mid-run re-entry gate must settle the node.
    /// </summary>
    private sealed class DeadlineDrivenSteppingExecutor : IBodyProgramNodeExecutor
    {
        private readonly MachineNodeExecutor machines;
        private readonly TimeBox clock;
        private readonly long overrunMs;

        public DeadlineDrivenSteppingExecutor(MachineNodeExecutor machines, TimeBox clock, long overrunMs)
        {
            this.machines = machines;
            this.clock = clock;
            this.overrunMs = overrunMs;
        }

        public List<(string ActionId, NodeExecutionBinding Execution, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Arguments)> Runs => this.machines.Runs;
        public int LoadVisits { get; private set; }

        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            if (grant.NodeId == "load")
            {
                this.LoadVisits++;
                this.clock.Value = this.overrunMs;
                return null;
            }
            return this.machines.Execute(grant, execution);
        }
    }

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");
    private static IReadOnlyDictionary<string, ActionProgramBinding> Bindings(params object[] values) => values.Chunk(2).ToDictionary(pair => (string)pair[0], pair => (ActionProgramBinding)pair[1], StringComparer.Ordinal);
    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> Args(params (string Key, string Type, string Value)[] values) =>
        new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(values.ToDictionary(pair => pair.Key, pair => new BodyProgramRuntimeValue(pair.Type, pair.Value), StringComparer.Ordinal));

    private static HostAdmissionGrant GrantFor(NodeAdmissionChallenge challenge) => new(
        challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision,
        challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs,
        $"grant-{challenge.NodeId}-{challenge.NodeAttempt}", "attachment_01", "host-policy_01");

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        private string? value;
        public string? Value => this.value;
        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);
        public bool TryWrite(string encodedState) { this.value = encodedState; return true; }
    }

    private sealed class FailSettleWriteStore : IBodyProgramJournalStore
    {
        private string? value;
        public int SettleWriteCount { get; private set; }
        public string? Value => this.value;
        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);
        public bool TryWrite(string encodedState)
        {
            // Refuse only the settle write (node_settled event): every other
            // write (program accepted, challenge, host-admitted, native-dispatch,
            // node_completed) succeeds exactly like a healthy store. This models
            // a durable settle failure without guessing the absolute write count.
            if (encodedState.Contains("node_settled", StringComparison.Ordinal))
            {
                this.SettleWriteCount++;
                return false;
            }
            this.value = encodedState;
            return true;
        }
    }
}