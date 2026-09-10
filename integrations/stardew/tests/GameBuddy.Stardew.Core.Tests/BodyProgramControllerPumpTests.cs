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

    private sealed class ImmediateAdmissionTransport : IBodyProgramAdmissionTransport
    {
        private readonly Dictionary<(string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt), HostAdmissionGrant> grants = new();
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public void Send(NodeAdmissionChallenge challenge)
        {
            this.Sent.Add(challenge);
            this.grants[(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt)] = new HostAdmissionGrant(
                challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision,
                challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs,
                $"grant-{challenge.NodeId}-{challenge.NodeAttempt}");
        }
        public HostAdmissionGrant? TryTakeGrant(string programId, string nodeId, int nodeAttempt, int admissionAttempt)
        {
            this.grants.TryGetValue((programId, nodeId, nodeAttempt, admissionAttempt), out HostAdmissionGrant? grant);
            return grant;
        }
    }

    private sealed class NoGrantAdmissionTransport : IBodyProgramAdmissionTransport
    {
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public void Send(NodeAdmissionChallenge challenge) => this.Sent.Add(challenge);
        public HostAdmissionGrant? TryTakeGrant(string programId, string nodeId, int nodeAttempt, int admissionAttempt) => null;
    }

    private sealed class MachineNodeExecutor : IBodyProgramNodeExecutor
    {
        private readonly string validatedMachineTargetIdentity;
        public MachineNodeExecutor(string validatedMachineTargetIdentity) => this.validatedMachineTargetIdentity = validatedMachineTargetIdentity;
        public bool FailNext { get; set; }
        public List<(string ActionId, NodeExecutionBinding Execution, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Arguments)> Runs { get; } = new();
        public BodyProgramTerminalResult Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            this.Runs.Add((grant.ActionId, execution, grant.CanonicalArguments));
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

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");
    private static IReadOnlyDictionary<string, ActionProgramBinding> Bindings(params object[] values) => values.Chunk(2).ToDictionary(pair => (string)pair[0], pair => (ActionProgramBinding)pair[1], StringComparer.Ordinal);
    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> Args(params (string Key, string Type, string Value)[] values) =>
        new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(values.ToDictionary(pair => pair.Key, pair => new BodyProgramRuntimeValue(pair.Type, pair.Value), StringComparer.Ordinal));

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        private string? value;
        public string? Read() => this.value;
        public bool TryWrite(string encodedState) { this.value = encodedState; return true; }
    }
}