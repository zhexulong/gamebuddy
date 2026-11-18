using System.Collections.ObjectModel;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// GATE: <c>a_node_outlives_its_admission_deadline:&lt;node&gt;</c> - no node may stay <c>AwaitingHostAdmission</c> once its
/// own admission deadline has passed.
///
/// <para>
/// THE DEFECT THIS EXISTS FOR, measured 2026-11-18 (`round76`, day 6). At 23:04:21 `plan_346` submitted `n01`
/// (`move_to_tile 43,23`) and collided with Lewis's cutscene. Its 60 s deadline expired at 23:05:21 and the pump logged
/// <c>admission_deadline_settled;node=n01;detail=held_by=cutscene_active</c> - and the node did not settle. Two seconds
/// later the Host's late grant arrived and the pump logged <c>grant_not_consumed;code=DeadlineExpired</c>. After that the
/// program was never mentioned again: `n01` stayed <c>AwaitingHostAdmission</c> for three in-game hours, and because
/// <see cref="FarmhandBodyProgramController"/> is a single-flight lock on one embodied actor, every later program was
/// refused <c>held_by=body_program:plan_346_…</c> - `plan_347` twice, at 23:15 and 23:19 - until the companion passed out
/// at 02:00. Nothing in the log said WHY the settlement had not happened, because the settlement's own answer was
/// discarded.
/// </para>
/// <para>
/// WHY A GATE AND NOT A TEST OF THE INCIDENT. A node can be minted into an admission from two journal shapes (a writable
/// one, and one whose neighbour already holds an unknown dispatch - <c>MayOperateOnPrograms</c> admits the mint in both,
/// while <c>IsMutable</c> is false in the second), and its admission can end in every shape the transport's result union
/// declares plus silence. The population below is derived from those two authorities - the result-type union and the
/// open-status enum - rather than from the one sequence that happened to burn three hours, so the next answer shape or
/// the next journal shape cannot slip through unexamined.
/// </para>
/// </summary>
public sealed class AdmissionDeadlineInvariantGateTests
{
    private readonly ITestOutputHelper output;

    public AdmissionDeadlineInvariantGateTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE MEASURED SEQUENCE, REPLAYED against the real journal authority: submit → the watchdog expires with the
    /// answer still outstanding → the Host's late grant arrives carrying <c>DeadlineExpired</c>. The node must be
    /// <c>Rejected</c> with that code, the program must not still be <c>Active</c>, and - because the single-flight lock
    /// is only as good as what releases it - the NEXT program must then be admitted.
    /// </summary>
    [Fact]
    public void ALateGrantPastTheDeadline_SettlesTheNode_AndSoTheNextProgramIsAdmitted()
    {
        var clock = new TimeBox { Value = 1_000_000 };
        OpenBodyProgramJournalAuthority authority = Open(new MemoryStore(), clock);
        var admission = new ScriptedAdmissionTransport(clock, (challenge, now) =>
            now > challenge.DeadlineMs ? new BodyNodeAdmissionGrantedResult(GrantFor(challenge)) : null);
        var executor = new CountingExecutor();
        var reported = new List<string>();
        var controller = new FarmhandBodyProgramController(authority, admission, executor)
        {
            Diagnostics = reported.Add,
            NowMs = () => clock.Value,
        };

        authority.Submit(Program("first")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        controller.Update();
        BodyProgramJournalNode awaiting = authority.Status("first").Snapshot!.Nodes.Single();
        awaiting.State.Should().Be(BodyProgramNodeState.AwaitingHostAdmission, "the challenge was sent and no answer has arrived yet");
        long deadlineMs = awaiting.DerivedDeadlineMs!.Value;
        admission.Sent.Should().ContainSingle(challenge => challenge.ProgramId == "first");

        // The watchdog expires with nothing dispatched, and THEN the late grant turns up - 23:05:21 and 23:05:23.
        clock.Value = deadlineMs + 1;
        controller.Update();
        controller.Update();

        BodyProgramStatusSnapshot settled = authority.Status("first").Snapshot!;
        BodyProgramJournalNode node = settled.Nodes.Single();
        node.State.Should().Be(
            BodyProgramNodeState.Rejected,
            "a_node_outlives_its_admission_deadline:{0}:no answer can arrive after the deadline, so the node that is still awaiting one is a node nothing will ever settle",
            node.NodeId);
        node.RejectionCode.Should().Be("deadline_expired", "the late grant's own answer is the code the node settles with");
        settled.State.Should().NotBe(
            BodyProgramState.Active,
            "an expired admission is a terminal answer, so the program cannot still be the program holding the body");
        executor.Runs.Should().Be(0, "nothing was dispatched: the node's one attempt is spent as an admission, not as a native call");

        // ④ THE LOCK. The whole cost of the measured defect was that the settlement's absence held every later program.
        authority.Submit(Program("second")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        controller.Update();
        admission.Sent.Should().Contain(
            challenge => challenge.ProgramId == "second",
            "the single-flight lock is released by the settlement, so the next program's node is admitted on the next pass");
    }

    /// <summary>
    /// THE GATE. Every shape an admission answer can take (the <see cref="BodyNodeAdmissionResult"/> union, plus silence)
    /// against every journal shape that can mint a challenge (writable, and one neighbour already in recovery). Once the
    /// node's own deadline has passed, no population member may still be <c>AwaitingHostAdmission</c>: whatever settled
    /// it, the state is terminal and it names its own code.
    /// </summary>
    [Fact]
    public void EveryAdmissionAnswerInEveryMintableJournalShape_LeavesNoNodeAwaitingPastItsDeadline()
    {
        var scripts = new Dictionary<string, (Func<NodeAdmissionChallenge, long, BodyNodeAdmissionResult?> Answer, string Settles)>(StringComparer.Ordinal)
        {
            // The one answer that is not a result at all: the Host never speaks again.
            ["silence"] = ((_, _) => null, "deadline_expired"),
            ["late_grant"] = ((challenge, now) => now > challenge.DeadlineMs ? new BodyNodeAdmissionGrantedResult(GrantFor(challenge)) : null, "deadline_expired"),
            ["late_rejection"] = ((challenge, now) => now > challenge.DeadlineMs ? new BodyNodeAdmissionRejectedResult(challenge, "policy_denied") : null, "policy_denied"),
            ["late_unavailable"] = ((challenge, now) => now > challenge.DeadlineMs ? new BodyNodeAdmissionUnavailableResult(challenge, "gate_not_executable") : null, "deadline_expired"),
        };
        // THE POPULATION'S FIRST HALF COMES FROM THE UNION, not from this list: a new answer shape added to the seam is a
        // shape nothing has decided how to end, so it must fail here rather than be silently unexamined.
        foreach (Type answered in typeof(BodyNodeAdmissionResult).Assembly.GetTypes().Where(type => type.IsSubclassOf(typeof(BodyNodeAdmissionResult))))
            AnswerNames.Values.Should().Contain(
                answered,
                "a_node_outlives_its_admission_deadline:unexamined_answer_shape:{0}",
                answered.Name);

        string[] journals = { "opened", "neighbour_in_recovery" };
        int examined = 0;
        int settled = 0;
        var abandoned = new List<string>();
        foreach ((string answer, (Func<NodeAdmissionChallenge, long, BodyNodeAdmissionResult?> script, string settles)) in scripts.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        foreach (string journal in journals)
        {
            var clock = new TimeBox { Value = 1_000_000 };
            OpenBodyProgramJournalAuthority authority = Open(new MemoryStore(), clock);
            // The NEIGHBOUR is answered on the spot: it exists only to put the journal into the shape under test, so its
            // own admission must not be the thing the scenario is about.
            var admission = new ScriptedAdmissionTransport(clock, (challenge, now) =>
                string.Equals(challenge.ProgramId, "neighbour", StringComparison.Ordinal)
                    ? new BodyNodeAdmissionGrantedResult(GrantFor(challenge))
                    : script(challenge, now));
            var controller = new FarmhandBodyProgramController(authority, admission, new UncertainForNeighbourExecutor())
            {
                NowMs = () => clock.Value,
            };
            if (journal == "neighbour_in_recovery")
            {
                // A save this build opened with an unfinished neighbour: the authority is not MUTABLE, and still admits.
                authority.Submit(Program("neighbour")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
                controller.Update();
                authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired, "the journal shape under test");
            }
            authority.Submit(Program("subject")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
            controller.Update();
            BodyProgramJournalNode waiting = authority.Status("subject").Snapshot!.Nodes.Single();
            waiting.State.Should().Be(
                BodyProgramNodeState.AwaitingHostAdmission,
                "a_node_outlives_its_admission_deadline:{0}:{1}:the population member was never minted, so it proves nothing",
                answer,
                journal);
            examined += 1;

            clock.Value = waiting.DerivedDeadlineMs!.Value + 1;
            for (int pass = 0; pass < 3; pass += 1) controller.Update();

            BodyProgramJournalNode node = authority.Status("subject").Snapshot!.Nodes.Single();
            if (node.State == BodyProgramNodeState.AwaitingHostAdmission)
            {
                abandoned.Add($"{answer}/{journal}:{node.NodeId}:expected={settles};found={node.State}");
                continue;
            }
            // A settlement is a STATE AND THE CODE IT SETTLED WITH: a node that ends `Rejected` with the wrong code is a
            // node whose receipt says something the deadline did not.
            node.RejectionCode.Should().Be(
                settles,
                "a_node_outlives_its_admission_deadline:{0}/{1}:{2}:the settlement names the wrong reason",
                answer,
                journal,
                node.NodeId);
            settled += 1;
        }

        examined.Should().Be(scripts.Count * journals.Length, "the gate must examine every population member it declares");
        abandoned.Should().BeEmpty(
            "a_node_outlives_its_admission_deadline:{0}",
            string.Join(",", abandoned));
        output.WriteLine($"nodes examined {examined} · settled {settled} · abandoned {abandoned.Count}");
    }

    /// <summary>
    /// The OTHER HALF of the journal population, and the reason it is not driven above: a status that cannot write a
    /// challenge cannot mint a node that outlives a deadline. Asserting it keeps the gate's silence about those statuses
    /// an answer instead of an omission.
    /// </summary>
    [Fact]
    public void AJournalThatCannotWriteCannotMintANodeThatOutlivesItsDeadline()
    {
        foreach (BodyProgramJournalOpenStatus status in Enum.GetValues<BodyProgramJournalOpenStatus>())
        {
            if (status is BodyProgramJournalOpenStatus.Empty or BodyProgramJournalOpenStatus.Opened or BodyProgramJournalOpenStatus.RecoveryRequired)
                continue;
            var clock = new TimeBox { Value = 1_000_000 };
            OpenBodyProgramJournalAuthority authority = Open(new UnwritableStore(status), clock);
            var controller = new FarmhandBodyProgramController(authority, new ScriptedAdmissionTransport(clock, (_, _) => null))
            {
                NowMs = () => clock.Value,
            };

            // The SUBMIT is where the write is attempted, so it is also where an unwritable journal says so.
            authority.Submit(Program("subject")).Code.Should().NotBe(
                BodyProgramSubmitCode.Accepted,
                "a journal that cannot write may not accept a program, so it has no node that could outlive a deadline:{0}",
                status);
            authority.OpenStatus.Should().BeOneOf(
                new[] { BodyProgramJournalOpenStatus.Corrupt, BodyProgramJournalOpenStatus.PersistenceReadFailed, BodyProgramJournalOpenStatus.PersistenceWriteFailed },
                "the status under test must be one the authority actually reports:{0}",
                status);
            controller.Update();
            authority.Snapshot.Programs.Should().BeEmpty("nothing was admitted, so nothing can be stranded:{0}", status);
        }
    }

    /// <summary>
    /// ① THE REJECTION'S ANSWER IS OBSERVABLE, AND A SETTLEMENT THE JOURNAL REFUSED IS NOT REPORTED AS ONE.
    ///
    /// <para>
    /// The measured log said <c>admission_deadline_settled;node=n01;detail=held_by=cutscene_active</c> at 23:05:21 and
    /// the node was still awaiting at 02:00: the line was printed BEFORE the rejection was attempted, its answer was
    /// discarded, and the challenge had already been dropped - so nothing could retry, and nothing said why. The journal
    /// here refuses the settlement's write while accepting the two writes before it, which is what a locked or
    /// failing journal is to the pump: the node stays awaiting, and the ONLY difference between a three-hour silent
    /// strand and a diagnosed one is whether the pump says so.
    /// </para>
    /// </summary>
    [Fact]
    public void ARejectionTheJournalRefuses_IsNamed_AndIsNotReportedAsASettlement()
    {
        var clock = new TimeBox { Value = 1_000_000 };
        var store = new MemoryStore { WritesBeforeFailure = 2 };
        OpenBodyProgramJournalAuthority authority = Open(store, clock);
        var admission = new ScriptedAdmissionTransport(clock, (_, _) => null);
        var reported = new List<string>();
        var controller = new FarmhandBodyProgramController(authority, admission, new CountingExecutor())
        {
            Diagnostics = reported.Add,
            NowMs = () => clock.Value,
        };
        authority.Submit(Program("subject")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        controller.Update();
        BodyProgramJournalNode waiting = authority.Status("subject").Snapshot!.Nodes.Single();
        waiting.State.Should().Be(BodyProgramNodeState.AwaitingHostAdmission);

        clock.Value = waiting.DerivedDeadlineMs!.Value + 1;
        controller.Update();

        authority.Status("subject").Snapshot!.Nodes.Single().State.Should().Be(
            BodyProgramNodeState.AwaitingHostAdmission,
            "the journal refused the write, so nothing was settled - and the pump may not pretend otherwise");
        reported.Should().Contain(
            line => line.Contains("admission_rejection_refused", StringComparison.Ordinal)
                && line.Contains("node=n01", StringComparison.Ordinal)
                && line.Contains("code=deadline_expired", StringComparison.Ordinal)
                && line.Contains("answer=PersistenceWriteFailed", StringComparison.Ordinal),
            "a rejection the journal refused is a refusal that has to name itself, or it is the measured silence again");
        reported.Should().NotContain(
            line => line.Contains("admission_deadline_settled", StringComparison.Ordinal),
            "the settlement line is a statement about the journal, so it may only be printed once the journal took it");
    }

    /// <summary>Each answer shape in the population above, by the key its scenario is registered under.</summary>
    private static readonly Dictionary<string, Type> AnswerNames = new(StringComparer.Ordinal)
    {
        ["late_grant"] = typeof(BodyNodeAdmissionGrantedResult),
        ["late_rejection"] = typeof(BodyNodeAdmissionRejectedResult),
        ["late_unavailable"] = typeof(BodyNodeAdmissionUnavailableResult),
    };

    private static OpenBodyProgramJournalAuthority Open(IBodyProgramJournalStore store, TimeBox clock) =>
        OpenBodyProgramJournalAuthority.Open(store, Catalog(), Scope(), () => Policy(), () => clock.Value);

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("machine_inspect", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
    });

    private static ActionProgramCandidate Program(string programId) => new(programId, new[]
    {
        new ActionProgramCandidateNode("n01", "machine_inspect",
            new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
            {
                ["x"] = new("integer", "43"),
                ["y"] = new("integer", "23"),
            }),
            Array.Empty<string>(),
            new ReadOnlyDictionary<string, ActionProgramBinding>(new Dictionary<string, ActionProgramBinding>(StringComparer.Ordinal))),
    });

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private static HostAdmissionGrant GrantFor(NodeAdmissionChallenge challenge) => new(
        challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision,
        challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs,
        $"grant-{challenge.NodeId}-{challenge.NodeAttempt}", "attachment_01", "host-policy_01");

    private sealed class TimeBox
    {
        public long Value { get; set; }
    }

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        private string? value;
        public int Writes { get; private set; }
        /// <summary>How many writes this store takes before it starts refusing - null for a journal that always writes.</summary>
        public int? WritesBeforeFailure { get; init; }
        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);
        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null)
        {
            if (this.WritesBeforeFailure is { } limit && this.Writes >= limit) return false;
            this.value = encodedState;
            this.Writes += 1;
            return true;
        }
    }

    /// <summary>A journal that opens in one of the statuses with no write to make: unreadable, or unwritable.</summary>
    private sealed class UnwritableStore : IBodyProgramJournalStore
    {
        private readonly BodyProgramJournalOpenStatus status;
        public UnwritableStore(BodyProgramJournalOpenStatus status) => this.status = status;
        public BodyProgramJournalReadResult Read() => this.status switch
        {
            BodyProgramJournalOpenStatus.Corrupt => new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, "{not-a-journal"),
            BodyProgramJournalOpenStatus.PersistenceReadFailed => new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.ReadFailed, null),
            _ => new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null),
        };
        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null) => false;
    }

    /// <summary>
    /// The Host's half of the seam, answering only once the node's own deadline has passed - which is what makes every
    /// scenario here the LATE answer the measured defect was stranded by, rather than an answer the pump could consume.
    /// </summary>
    private sealed class ScriptedAdmissionTransport : IBodyProgramAdmissionTransport
    {
        private readonly TimeBox clock;
        private readonly Func<NodeAdmissionChallenge, long, BodyNodeAdmissionResult?> answer;

        public ScriptedAdmissionTransport(TimeBox clock, Func<NodeAdmissionChallenge, long, BodyNodeAdmissionResult?> answer)
        {
            this.clock = clock;
            this.answer = answer;
        }

        public List<NodeAdmissionChallenge> Sent { get; } = new();
        public long AttachmentGeneration => 1;

        public string? Send(NodeAdmissionChallenge challenge)
        {
            this.Sent.Add(challenge);
            return null;
        }

        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt) =>
            this.Sent.FirstOrDefault(challenge => challenge.ProgramId == programId && challenge.NodeId == nodeId
                && challenge.NodeAttempt == nodeAttempt && challenge.AdmissionAttempt == admissionAttempt) is { } asked
                ? this.answer(asked, this.clock.Value)
                : null;
    }

    /// <summary>The native side, which a late answer must never reach.</summary>
    private sealed class CountingExecutor : IBodyProgramNodeExecutor
    {
        public int Runs { get; private set; }

        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            this.Runs += 1;
            return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt-1", "evidence-1", "postcondition-1");
        }
    }

    /// <summary>
    /// The neighbour that a save left with an unknown dispatch: its one node settles `Uncertain`, which is what puts the
    /// whole journal in <see cref="BodyProgramJournalOpenStatus.RecoveryRequired"/> while a neighbour program still runs.
    /// </summary>
    private sealed class UncertainForNeighbourExecutor : IBodyProgramNodeExecutor
    {
        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution) =>
            string.Equals(grant.ProgramId, "neighbour", StringComparison.Ordinal)
                ? new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Uncertain, Array.Empty<RuntimeFact>(), null, null, null)
                : null;
    }
}
