using System.Collections.ObjectModel;
using System.Globalization;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// GATE: <c>a_program_does_not_ask_the_host_once_per_node:&lt;program&gt;</c> - the number of admission questions a
/// programme puts on the pipe may not grow with the number of nodes it has.
///
/// <para>
/// THE MEASUREMENT THIS EXISTS FOR, `round84`: 331 <c>admission</c> challenges for 329 program nodes, and 272
/// intra-programme node switches costing 43.7 s - 161 ms each, about ten frames of a stopped body, for an answer the
/// Host had already given when it compiled and preflighted the whole programme before it could be submitted. The
/// question every one of those frames asked was about the programme's scope, so its answer belongs to the programme.
/// </para>
/// <para>
/// WHAT THE GATE READS, AND WHY IT IS NOT THE 161 ms. The wait needs a live run to see. The round trip does not: it is
/// one call on the transport per node, so the property "the pipe call is not paid per node" is measurable here, on the
/// real journal authority and the real controller, with a transport that counts what it was asked. <c>per-node</c> above
/// 1 is the measured symptom (more questions than nodes); a multi-node programme that asks more than ONCE is the
/// property itself, and it is the reading that would have failed on `round84`.
/// </para>
/// </summary>
public sealed class ProgramAdmissionLeaseGateTests
{
    private readonly ITestOutputHelper output;

    public ProgramAdmissionLeaseGateTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// A three-node programme, end to end: the first node's challenge is asked and answered, every later node runs on
    /// that answer, and the gate reads one challenge against three nodes.
    /// </summary>
    [Fact]
    public void AProgrammeOfThreeNodesAsksTheHostOnceAndRunsAllThree()
    {
        var clock = new TimeBox { Value = 1_000_000 };
        OpenBodyProgramJournalAuthority authority = Open(new MemoryStore(), clock);
        var admission = new GrantingAdmissionTransport();
        var executor = new CountingExecutor();
        var controller = new FarmhandBodyProgramController(authority, admission, executor) { NowMs = () => clock.Value };
        authority.Submit(ThreeNodeProgram("plan_101")).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        for (int tick = 0; tick < 20 && authority.Status("plan_101").Snapshot!.State == BodyProgramState.Active; tick++)
            controller.Update();

        BodyProgramStatusSnapshot settled = authority.Status("plan_101").Snapshot!;
        settled.State.Should().Be(BodyProgramState.Succeeded);
        settled.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Succeeded);
        executor.Runs.Should().Equal("n01", "n02", "n03");

        this.Gate("plan_101", challenges: admission.Sent.Count(challenge => challenge.ProgramId == "plan_101"), nodes: settled.Nodes.Count);
    }

    /// <summary>
    /// THE EXPIRY THE CARRIED ADMISSION IS BOUND TO. A farmhand action policy that moves between two nodes of one
    /// programme is a scope change, so the answer the Host gave for the first node no longer covers the second: the
    /// programme stops carrying an admission, says so, and dispatches nothing under it.
    /// </summary>
    [Fact]
    public void APolicyIdentityThatMovesEndsTheCarriedAdmissionBeforeTheNextNode()
    {
        var clock = new TimeBox { Value = 1_000_000 };
        var policy = new PolicyBox();
        OpenBodyProgramJournalAuthority authority = Open(new MemoryStore(), clock, () => policy.Value);
        var admission = new GrantingAdmissionTransport();
        var executor = new CountingExecutor();
        var reported = new List<string>();
        var controller = new FarmhandBodyProgramController(authority, admission, executor)
        {
            Diagnostics = reported.Add,
            NowMs = () => clock.Value,
        };
        authority.Submit(ThreeNodeProgram("plan_102")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        controller.Update();
        executor.Runs.Should().Equal("n01");

        // The Mod's capability surface publishes a new policy identity - the one thing that can move a programme's
        // scope while the programme is alive.
        policy.Value = new BodyProgramPolicyIdentity("policy-b", 2);
        controller.Update();
        controller.Update();

        executor.Runs.Should().Equal(
            new[] { "n01" },
            "the second node may not run under an answer given for a policy that has moved on");
        authority.Status("plan_102").Snapshot!.Nodes.Single(node => node.NodeId == "n02").State
            .Should().Be(BodyProgramNodeState.Pending);
        reported.Should().Contain(
            line => line.Contains("admission_lease_dropped", StringComparison.Ordinal)
                && line.Contains("program=plan_102", StringComparison.Ordinal)
                && line.Contains("reason=policy_identity_stale", StringComparison.Ordinal),
            "a carried admission that stops covering the programme is a fact the log has to state");
        admission.Sent.Should().ContainSingle("the second node was never put on the pipe: the policy refuses before the mint");
    }

    /// <summary>
    /// The gate line, printed and asserted in one place so every reading of it says the same thing.
    ///
    /// Both bounds are stated: the one the measurement named (<c>per-node &gt; 1</c>, a programme asking more often than
    /// it has nodes) and the one the change is for (a MULTI-NODE programme asking more than once at all). A reading with
    /// no nodes, or with no challenge at all, is not a pass: it is a gate that agreed with itself.
    /// </summary>
    private void Gate(string programId, int challenges, int nodes)
    {
        double perNode = nodes == 0 ? 0 : (double)challenges / nodes;
        string line = string.Create(
            CultureInfo.InvariantCulture,
            $"a_program_does_not_ask_the_host_once_per_node:{programId} challenges {challenges} · nodes {nodes} · per-node {perNode:0.###}");
        this.output.WriteLine(line);

        nodes.Should().BeGreaterThan(
            0,
            "a gate whose population is zero agrees with itself, and {0} must have nodes for this reading to mean anything",
            programId);
        challenges.Should().BeGreaterThan(
            0,
            "the first node is the one the Host answers and the programme carries itself on that answer: {0}",
            line);
        (challenges <= nodes).Should().BeTrue(
            "a per-node cost above 1 means the programme put more questions on the pipe than it had nodes: {0}",
            line);
        (nodes == 1 || challenges == 1).Should().BeTrue(
            "every node after the first is admitted under the answer the first one was given: {0}",
            line);
    }

    private static OpenBodyProgramJournalAuthority Open(IBodyProgramJournalStore store, TimeBox clock, Func<BodyProgramPolicyIdentity>? policy = null) =>
        OpenBodyProgramJournalAuthority.Open(store, Catalog(), Scope(), policy ?? (static () => Policy()), () => clock.Value);

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("machine_inspect", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
    });

    /// <summary>
    /// Three steps that must happen in order and consume nothing from each other: every published action claims
    /// `embodied_actor`, so the ordering edge is what makes them one programme rather than a claim conflict.
    /// </summary>
    private static ActionProgramCandidate ThreeNodeProgram(string programId) => new(programId, new[]
    {
        new ActionProgramCandidateNode("n01", "machine_inspect", Arguments("1"), Array.Empty<string>(), NoBindings()),
        new ActionProgramCandidateNode("n02", "machine_inspect", Arguments("2"), Array.Empty<string>(), NoBindings()) { OrderedAfter = new[] { "n01" } },
        new ActionProgramCandidateNode("n03", "machine_inspect", Arguments("3"), Array.Empty<string>(), NoBindings()) { OrderedAfter = new[] { "n02" } },
    });

    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> Arguments(string y) =>
        new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
        {
            ["x"] = new("integer", "43"),
            ["y"] = new("integer", y),
        });

    private static IReadOnlyDictionary<string, ActionProgramBinding> NoBindings() =>
        new ReadOnlyDictionary<string, ActionProgramBinding>(new Dictionary<string, ActionProgramBinding>(StringComparer.Ordinal));

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private static HostAdmissionGrant GrantFor(NodeAdmissionChallenge challenge) => new(
        challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision,
        challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs,
        $"grant_{challenge.NodeId}_{challenge.NodeAttempt}", "attachment_01", "policy-a");

    private sealed class TimeBox
    {
        public long Value { get; set; }
    }

    /// <summary>The identity the Mod's capability surface currently publishes - a push can change it mid-session.</summary>
    private sealed class PolicyBox
    {
        public BodyProgramPolicyIdentity Value { get; set; } = Policy();
    }

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        private string? value;
        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);
        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null)
        {
            this.value = encodedState;
            return true;
        }
    }

    /// <summary>The Host's half of the seam: every challenge it is asked is granted, and every ask is counted.</summary>
    private sealed class GrantingAdmissionTransport : IBodyProgramAdmissionTransport
    {
        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public long AttachmentGeneration => 1;
        public string? Send(NodeAdmissionChallenge challenge)
        {
            this.Sent.Add(challenge);
            return null;
        }
        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt) =>
            this.Sent.SingleOrDefault(asked => asked.ProgramId == programId && asked.NodeId == nodeId
                && asked.NodeAttempt == nodeAttempt && asked.AdmissionAttempt == admissionAttempt) is { } challenge
                ? new BodyNodeAdmissionGrantedResult(GrantFor(challenge))
                : null;
    }

    /// <summary>The native side, recording which node each dispatch actually ran.</summary>
    private sealed class CountingExecutor : IBodyProgramNodeExecutor
    {
        public List<string> Runs { get; } = new();
        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            this.Runs.Add(grant.NodeId);
            return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt-1", "evidence-1", "postcondition-1");
        }
    }
}
