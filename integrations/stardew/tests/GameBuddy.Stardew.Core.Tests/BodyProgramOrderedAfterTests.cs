using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The second edge: `orderedAfter` - "do not start before this predecessor is terminal; do not skip me if it fails".
///
/// <para>
/// The defect these cases pin, measured over one finished run of 293 nodes: `succeeded 197, failed 26,
/// skipped_dependency 58`, of which `till_soil` alone was 64 nodes with 30 succeeded, 5 failed and 29 skipped. The tiles
/// are independent, and a fifth of that work died because one earlier tile failed: the compiler had exactly one relation
/// to spend, `dependsOn`, and it carries both ordering (required by the claim rule, since every published action claims
/// `embodied_actor`) and failure propagation. These cases are written against the WIRE, so they prove the frame the Host
/// sends is the frame that behaves: a candidate built in memory would prove neither.
/// </para>
/// </summary>
public sealed class BodyProgramOrderedAfterTests
{
    /// <summary>
    /// A1: at most one node of a program is in flight, and the decision is the authority's - not the pump loop's.
    ///
    /// <para>
    /// Red before the guard existed: two nodes with no edge between them and no shared claim are both eligible, so
    /// `StartEligibleNodes`'s `while` minted a challenge for each in ONE tick. The invariant is what makes the second
    /// edge safe to add: ordering may serialise nodes, never parallelise two native mutations of one embodied actor.
    /// </para>
    /// </summary>
    [Fact]
    public void AtMostOneNodeOfAProgramIsInFlightEvenWhenTheNodesAreIndependent()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new SwitchableExecutor();
        var controller = new FarmhandBodyProgramController(authority, admission, executor) { NowMs = () => 10 };
        Submit(authority, "program", NodeJson("a", "till_soil"), NodeJson("b", "machine_inspect")).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        executor.Hold = true;
        controller.Update();

        admission.Sent.Should().ContainSingle().Which.NodeId.Should().Be("a");
        BodyProgramStatusSnapshot status = authority.Status("program").Snapshot!;
        InFlight(status).Should().Be(1, "one program dispatches one embodied action at a time");
        status.Nodes.Single(node => node.NodeId == "b").State.Should().Be(BodyProgramNodeState.Pending);

        controller.Update();
        controller.Update();
        admission.Sent.Should().ContainSingle();
        InFlight(authority.Status("program").Snapshot!).Should().Be(1);

        // The invariant is "at most one", not "one for ever": once the held node settles, the other is minted.
        executor.Hold = false;
        controller.Update();
        controller.Update();
        admission.Sent.Select(challenge => challenge.NodeId).Should().Equal("a", "b");
        authority.Status("program").Snapshot!.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Succeeded);
    }

    /// <summary>
    /// A2: a node never starts before every `orderedAfter` predecessor is terminal - and terminal is not succeeded.
    ///
    /// <para>
    /// Red before the edge reached the wire and the journal: the candidate was refused outright
    /// (`invalid_body_program_request`, naming no field), because a 6-key node was not a shape this Mod read.
    /// </para>
    /// </summary>
    [Fact]
    public void AnOrderingOnlySuccessorStartsOnceItsPredecessorIsTerminalAndRunsEvenAfterItFailed()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new SwitchableExecutor { FailNodeId = "a" };
        var controller = new FarmhandBodyProgramController(authority, admission, executor) { NowMs = () => 10 };

        Submit(authority, "program", NodeJson("a", "till_soil"), NodeJson("b", "till_soil", orderedAfter: new[] { "a" }))
            .Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        admission.Sent.Should().ContainSingle().Which.NodeId.Should().Be("a");
        BodyProgramStatusSnapshot afterFailure = authority.Status("program").Snapshot!;
        afterFailure.Nodes.Single(node => node.NodeId == "a").State.Should().Be(BodyProgramNodeState.Failed);
        afterFailure.Nodes.Single(node => node.NodeId == "b").State.Should().Be(BodyProgramNodeState.Pending);
        afterFailure.State.Should().Be(BodyProgramState.Active, "the ordering successor still has work to do");

        controller.Update();

        admission.Sent.Select(challenge => challenge.NodeId).Should().Equal("a", "b");
        BodyProgramStatusSnapshot settled = authority.Status("program").Snapshot!;
        settled.Nodes.Single(node => node.NodeId == "b").State.Should().Be(BodyProgramNodeState.Succeeded);
        settled.State.Should().Be(BodyProgramState.Failed, "one step failed; the neighbour that ran is not a skip");
        authority.Events("program", 0, 32).Events.Should().NotContain(@event => @event.Kind == "node_skipped");
    }

    /// <summary>
    /// A2, at the rule that decides it: `OrderedAfterReached` demands TERMINAL, not Succeeded.
    ///
    /// <para>
    /// The second half is the whole point of the edge. An ordering predecessor that failed settles whatever it was going
    /// to be, so its successor may start; demanding `Succeeded` here would turn the 29 skips of one failed tile into 29
    /// nodes that never run at all - the same defect with a different name.
    /// </para>
    /// </summary>
    [Fact]
    public void AnOrderingPredecessorMustBeTerminalNotSuccessful()
    {
        IReadOnlyList<BodyProgramGraphNode> graph = new[]
        {
            new BodyProgramGraphNode("a", Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>()),
            new BodyProgramGraphNode("b", Array.Empty<string>(), new[] { "a" }, Array.Empty<string>()),
        };

        BodyProgramGraphRules.EligibleToStart(graph, States(("a", BodyProgramNodeState.Pending), ("b", BodyProgramNodeState.Pending)), "b")
            .Should().BeFalse();
        BodyProgramGraphRules.EligibleToStart(graph, States(("a", BodyProgramNodeState.Running), ("b", BodyProgramNodeState.Pending)), "b")
            .Should().BeFalse();
        BodyProgramGraphRules.EligibleToStart(graph, States(("a", BodyProgramNodeState.Failed), ("b", BodyProgramNodeState.Pending)), "b")
            .Should().BeTrue();
        BodyProgramGraphRules.EligibleToStart(graph, States(("a", BodyProgramNodeState.Succeeded), ("b", BodyProgramNodeState.Pending)), "b")
            .Should().BeTrue();
        BodyProgramGraphRules.EligibleToStart(graph, States(("a", BodyProgramNodeState.SkippedDependency), ("b", BodyProgramNodeState.Pending)), "b")
            .Should().BeTrue();
        // A pass that did PART of its rows is over too, and this is the case the partial verdict exists for: the ordering
        // successor of a 58-of-60 strip starts, so a plan can keep going after one refused tile.
        BodyProgramGraphRules.EligibleToStart(graph, States(("a", BodyProgramNodeState.PartiallySucceeded), ("b", BodyProgramNodeState.Pending)), "b")
            .Should().BeTrue("a partial pass settled its rows, so what only had to happen after it may start");

        // ...and a CONSUMING successor still may not: a partial pass produces no output fact, so the node that needs one
        // would fail its binding. That distinction is the graph's, not the verdict's - the journal settles such a node
        // `SkippedDependency` rather than leaving it Pending for ever.
        IReadOnlyList<BodyProgramGraphNode> consuming = new[]
        {
            new BodyProgramGraphNode("a", Array.Empty<string>(), Array.Empty<string>(), Array.Empty<string>()),
            new BodyProgramGraphNode("b", new[] { "a" }, Array.Empty<string>(), Array.Empty<string>()),
        };
        BodyProgramGraphRules.EligibleToStart(consuming, States(("a", BodyProgramNodeState.PartiallySucceeded), ("b", BodyProgramNodeState.Pending)), "b")
            .Should().BeFalse("a partial predecessor produced no fact, so a node that consumes it cannot start");
    }

    /// <summary>
    /// A3: a failed node skips exactly its `dependsOn` consumers - and the skip names the node it was owed to - while its
    /// `orderedAfter` successors still run.
    ///
    /// <para>
    /// The skip set is the point of the measured defect: `till_soil` 64 nodes, 5 failed, 29 skipped. `b` is a consuming
    /// step and must still be skipped (its input can never exist); `c` merely had to happen after `a` and must run. The
    /// producer `a` is named by the durable edge `b` carries, which is the same edge the Host's `skippedBecause`
    /// projection joins on (`program-status-wait.ts` `producersThatSkipped`), so a skip this graph can explain is a skip
    /// the caller is told the reason for.
    /// </para>
    /// </summary>
    [Fact]
    public void AFailedNodeSkipsItsConsumptionConsumersAndItsOrderingSuccessorStillRuns()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new ImmediateAdmissionTransport();
        var executor = new SwitchableExecutor { FailNodeId = "a" };
        var controller = new FarmhandBodyProgramController(authority, admission, executor) { NowMs = () => 10 };

        Submit(authority, "program",
                NodeJson("a", "till_soil"),
                NodeJson("b", "till_soil", dependsOn: new[] { "a" }),
                NodeJson("c", "machine_inspect", orderedAfter: new[] { "a" }))
            .Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        BodyProgramStatusSnapshot afterFailure = authority.Status("program").Snapshot!;
        afterFailure.Nodes.Single(node => node.NodeId == "a").State.Should().Be(BodyProgramNodeState.Failed);
        afterFailure.Nodes.Single(node => node.NodeId == "b").State.Should().Be(BodyProgramNodeState.SkippedDependency);
        afterFailure.Nodes.Single(node => node.NodeId == "b").NodeAttempt.Should().Be(0);
        afterFailure.Nodes.Single(node => node.NodeId == "c").State.Should().Be(BodyProgramNodeState.Pending);
        afterFailure.State.Should().Be(BodyProgramState.Active);

        // The skip names the producer: `b` carries `a` as its consumption edge, and it is the only skipped node.
        VerifiedBodyProgramNode[] descriptors = authority.Snapshot.Programs.Single().Program.Nodes.ToArray();
        descriptors.Single(node => node.NodeId == "b").DependsOn.Should().Equal("a");
        descriptors.Single(node => node.NodeId == "b").OrderedAfter.Should().BeEmpty();
        descriptors.Single(node => node.NodeId == "c").DependsOn.Should().BeEmpty();
        descriptors.Single(node => node.NodeId == "c").OrderedAfter.Should().Equal("a");
        authority.Events("program", 0, 32).Events.Where(@event => @event.Kind == "node_skipped").Select(@event => @event.NodeId)
            .Should().Equal("b");

        controller.Update();

        admission.Sent.Select(challenge => challenge.NodeId).Should().Equal("a", "c");
        BodyProgramStatusSnapshot settled = authority.Status("program").Snapshot!;
        settled.Nodes.Single(node => node.NodeId == "c").State.Should().Be(BodyProgramNodeState.Succeeded);
        settled.Nodes.Single(node => node.NodeId == "b").State.Should().Be(BodyProgramNodeState.SkippedDependency);
        settled.State.Should().Be(BodyProgramState.Failed);
    }

    /// <summary>
    /// A4: STOP settles every unsettled node as `Cancelled` and is never counted as a dependency skip.
    ///
    /// <para>
    /// A stop is the player's own decision, and it already has a node state and a program state of its own. Recorded as a
    /// skip it would read as "something upstream failed", which is a cause nobody named and no caller can act on - and
    /// the run that measured 58 skips would have been measuring the stop button too.
    /// </para>
    /// </summary>
    [Fact]
    public void StopCancelsEveryUnsettledNodeAndIsNeverADependencySkip()
    {
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new NoGrantAdmissionTransport();
        var controller = new FarmhandBodyProgramController(authority, admission, new SwitchableExecutor()) { NowMs = () => 10 };
        Submit(authority, "program", NodeJson("a", "till_soil"), NodeJson("b", "till_soil", dependsOn: new[] { "a" }),
            NodeJson("c", "till_soil", dependsOn: new[] { "b" })).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();
        authority.Status("program").Snapshot!.Nodes.Single(node => node.NodeId == "a").State.Should().Be(BodyProgramNodeState.AwaitingHostAdmission);

        controller.TryStop("program", 1).IsSuccess.Should().BeTrue();

        BodyProgramStatusSnapshot stopped = authority.Status("program").Snapshot!;
        stopped.State.Should().Be(BodyProgramState.Cancelled);
        stopped.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Cancelled);
        stopped.Nodes.Should().NotContain(node => node.State == BodyProgramNodeState.SkippedDependency);
        authority.Events("program", 0, 32).Events.Should().NotContain(@event => @event.Kind == "node_skipped");
        authority.Events("program", 0, 32).Events.Where(@event => @event.Kind is "stopped" or "node_skipped").Should().ContainSingle()
            .Which.Kind.Should().Be("stopped");
    }

    private static int InFlight(BodyProgramStatusSnapshot status) => status.Nodes.Count(node => node.State
        is BodyProgramNodeState.AwaitingHostAdmission or BodyProgramNodeState.HostAdmitted or BodyProgramNodeState.Running);

    private static IReadOnlyDictionary<string, BodyProgramNodeState> States(params (string NodeId, BodyProgramNodeState State)[] states) =>
        states.ToDictionary(state => state.NodeId, state => state.State, StringComparer.Ordinal);

    private static OpenBodyProgramJournalAuthority Open() =>
        OpenBodyProgramJournalAuthority.Open(new MemoryStore(), Catalog(), Scope(), () => Policy(), () => 10);

    /// <summary>
    /// Two steps whose claims are genuinely independent: `till_soil` claims the embodied actor, and the inspection claims
    /// one machine. A catalog where every action claimed `embodied_actor` could not express "these two nodes have no
    /// reason to wait for each other", which is the shape every case above needs somewhere.
    /// </summary>
    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("till_soil", 1, Arguments(),
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
        new BodyProgramActionDescriptor("machine_inspect", 1, Arguments(),
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("machine_state", BodyProgramResourceTemplateValue.ActionId) },
            null, WatchdogMs: 1000),
    });

    private static BodyProgramArgumentDescriptor[] Arguments() => new[]
    {
        new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer),
        new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer),
    };

    /// <summary>A `program_submit` frame's node. `orderedAfter` is written only when the caller asks for it, so a case that does not carry the edge is exactly the frame today's Host sends.</summary>
    private static string NodeJson(string nodeId, string actionId, string[]? dependsOn = null, string[]? orderedAfter = null) =>
        "{\"nodeId\":\"" + nodeId + "\",\"actionId\":\"" + actionId + "\",\"arguments\":{\"x\":{\"type\":\"integer\",\"canonicalValue\":\"1\"},\"y\":{\"type\":\"integer\",\"canonicalValue\":\"2\"}},"
        + "\"dependsOn\":[" + Join(dependsOn) + "]"
        + (orderedAfter is null ? "" : ",\"orderedAfter\":[" + Join(orderedAfter) + "]")
        + ",\"bindings\":{}}";

    private static string Join(string[]? values) => string.Join(",", (values ?? Array.Empty<string>()).Select(value => "\"" + value + "\""));

    /// <summary>
    /// Submits through the real `program_submit` decoder: the candidate is the Mod's own reading of the Host's frame,
    /// never a hand-built Core record, so a key the decoder does not know shows up here and not in production.
    /// </summary>
    private static BodyProgramSubmitResult Submit(OpenBodyProgramJournalAuthority authority, string programId, params string[] nodes)
    {
        const string prefix = "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,"
            + "\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save\",\"worldId\":\"world\",\"playerId\":\"player\",\"companionId\":\"companion\"},"
            + "\"type\":\"program_submit\",\"payload\":";
        string payload = "{\"programId\":\"" + programId + "\",\"nodes\":[" + string.Join(",", nodes) + "]}";
        bool decoded = BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(prefix + payload + "}", out BridgeEnvelope<ActionProgramCandidate>? envelope, out string reason);
        decoded.Should().BeTrue(reason);
        return authority.Submit(envelope!.Payload);
    }

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private sealed class ImmediateAdmissionTransport : IBodyProgramAdmissionTransport
    {
        private readonly Dictionary<(string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt), HostAdmissionGrant> grants = new();
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public long AttachmentGeneration => 1;
        public void Send(NodeAdmissionChallenge challenge)
        {
            this.Sent.Add(challenge);
            this.grants[(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt)] = new HostAdmissionGrant(
                challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision,
                challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs,
                $"grant-{challenge.NodeId}-{challenge.NodeAttempt}", "attachment_01", "host-policy_01");
        }
        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt)
        {
            this.grants.TryGetValue((programId, nodeId, nodeAttempt, admissionAttempt), out HostAdmissionGrant? grant);
            return grant is null ? null : new BodyNodeAdmissionGrantedResult(grant);
        }
    }

    private sealed class NoGrantAdmissionTransport : IBodyProgramAdmissionTransport
    {
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public long AttachmentGeneration => 1;
        public void Send(NodeAdmissionChallenge challenge) => this.Sent.Add(challenge);
        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt) => null;
    }

    /// <summary>`Hold` keeps a dispatched node bound-Running (the null continuation), so "in flight" is observable inside one tick; `FailNodeId` fails exactly one node and succeeds every other.</summary>
    private sealed class SwitchableExecutor : IBodyProgramNodeExecutor
    {
        public bool Hold { get; set; }
        public string? FailNodeId { get; set; }

        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            if (this.Hold) return null;
            if (grant.NodeId == this.FailNodeId) return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Failed, Array.Empty<RuntimeFact>(), null, null, null);
            return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt", "evidence", "postcondition");
        }
    }

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        private string? value;
        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);
        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null) { this.value = encodedState; return true; }
    }
}
