using System.Collections.ObjectModel;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// GATE: <c>a_programme_between_its_own_nodes_keeps_the_body:&lt;program&gt;</c> - of the programmes alive at once, the one
/// that has something it could run keeps the actor; the body passes to a queued programme only when the holder has nothing
/// to run, is waiting on the world, or has been settled by the Host.
///
/// <para>
/// THE MEASUREMENT THIS EXISTS FOR, `round85`. `plan_453` had `n16 refill_watering_can -> n17 water_crop` with a
/// 24 172 ms gap between two of its OWN nodes, and inside that gap `plan_471` and `plan_475` - both submitted later - ran
/// (<c>node_waiting; program=plan_453; held_by=body_program:plan_471</c>). `plan_515` lost its own `n01 -> n02` gap to
/// three later programmes the same way (12 703 ms). The gap is one pass wide and it is structural: a node settles in the
/// controller's <c>AdvanceRunningNodes</c>, which runs AFTER <c>StartEligibleNodes</c> for the same programme, so for the
/// rest of that pass the programme that had just finished a node owned nothing - and the next programme in the journal's
/// order took the actor on its own start gate. Intra-programme node switches then cost 350 ms instead of 161 ms,
/// `water_crop` failed 17 times `crop_target_unavailable` against a plot it had already prepared, and the run's overlap
/// residual was 56.9 s of two programmes' nodes claiming one actor's time.
/// </para>
/// <para>
/// WHY THESE TWO READINGS ARE THE WHOLE POPULATION. The gate answers one question - which programme holds the body - and a
/// programme has exactly two answers to give: it has something to run (a node in flight, or a node it could start), or it
/// does not (waiting on its dependency, waiting on the world, or settled). The readings below are those two, driven through
/// the real journal authority and the real pump, so an implementation that always yields fails the first and one that never
/// yields fails the second.
/// </para>
/// </summary>
public sealed class ProgramHoldingTheBodyGateTests
{
    /// <summary>
    /// ① A PROGRAMME THAT IS ADVANCING KEEPS THE ACTOR. `plan_453`'s own successor is pending and its predecessor settles
    /// in the pass that has already run its start gate, which is exactly the gap `plan_471` and `plan_475` ran inside.
    /// `plan_471` may not start: nothing is minted for it, its watchdog never starts, and the line that made the measured
    /// bug visible names the programme that is advancing - not a node of it.
    /// </summary>
    [Fact]
    public void AProgrammeBetweenItsOwnNodesKeepsTheBodyAgainstALaterSubmission()
    {
        var reported = new List<string>();
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new GrantingAdmissionTransport();
        var executor = new SteppingExecutor(programId: "plan_453", nodeId: "n01", terminalOnVisit: 2);
        var controller = new FarmhandBodyProgramController(authority, admission, executor)
        {
            Diagnostics = reported.Add,
            NowMs = () => 10,
        };

        authority.Submit(TwoNodeProgram("plan_453")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        controller.Update();
        Node(authority, "plan_453", "n01").State.Should().Be(
            BodyProgramNodeState.Running,
            "the first node is in the world, so the body is in use before the second programme exists");

        // THE LATER SUBMISSION, while the first programme is mid-node - the measured `plan_471` against `plan_453`.
        authority.Submit(SingleNodeProgram("plan_471", "water_crop")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        // This pass settles `n16`: `AdvanceRunningNodes` runs after `StartEligibleNodes` for the same programme, so for the
        // rest of this pass `plan_453` has nothing in flight. That is the gap the measured run fell into.
        controller.Update();

        Node(authority, "plan_453", "n01").State.Should().Be(BodyProgramNodeState.Succeeded);
        Node(authority, "plan_453", "n02").State.Should().Be(
            BodyProgramNodeState.Pending,
            "the successor of a node that settled this pass has not been started yet, which is the gap under test");
        Node(authority, "plan_471", "n01").State.Should().Be(
            BodyProgramNodeState.Pending,
            "a_programme_between_its_own_nodes_keeps_the_body:plan_471:the body belongs to the programme that still has a node to run, not to whichever programme was submitted next");
        Challenges(authority, "plan_471").Should().BeEmpty(
            "a queued programme yields before the mint, so its one attempt is unspent and its watchdog never started");
        reported.Should().Contain(
            line => line.Contains("node_waiting", StringComparison.Ordinal)
                && line.Contains("program=plan_471", StringComparison.Ordinal)
                && line.Contains("held_by=body_program:plan_453", StringComparison.Ordinal),
            "the line that made `round85` visible has to keep naming the holder - and the holder is now the programme that is advancing");

        // ② AND THE FIRST PROGRAMME FINISHES ITS OWN PLAN BEFORE THE QUEUED ONE RUNS.
        controller.Update();
        authority.Status("plan_453").Snapshot!.State.Should().Be(BodyProgramState.Succeeded);
        authority.Status("plan_453").Snapshot!.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Succeeded);
        executor.Runs.Should().Equal(
            new[] { "plan_453/n01", "plan_453/n01", "plan_453/n02", "plan_471/n01" },
            "one node at a time, and every one of them the advancing programme's before the queued programme's first");
    }

    /// <summary>
    /// ③ A PROGRAMME THE WORLD IS HOLDING YIELDS. The box on screen holds every action except the family that exists to
    /// close it (<see cref="BodyProgramDispatchGate.HoldOf"/>, the catalog's own answer - not a fake hold here), so the
    /// programme waiting on `water_crop` is WAITING and not advancing, and the programme that can answer the box runs.
    /// Without this half the hold above would be a lease on a programme's whole life: one plan parked behind a dialogue
    /// box would starve every other plan for as long as the box stood open.
    /// </summary>
    [Fact]
    public void AProgrammeTheWorldIsHoldingYieldsTheBodyToTheNextProgramme()
    {
        FarmhandActionCatalog.IsModalResolving("answer_dialogue").Should().BeTrue(
            "the second programme answers the box, which only works while that id belongs to the modal-resolving family the gate derives from");

        bool boxOpen = true;
        var reported = new List<string>();
        OpenBodyProgramJournalAuthority authority = Open();
        var admission = new GrantingAdmissionTransport();
        var executor = new CountingExecutor();
        var controller = new FarmhandBodyProgramController(authority, admission, executor)
        {
            Diagnostics = reported.Add,
            NowMs = () => 10,
            HoldOf = actionId => BodyProgramDispatchGate.HoldOf(
                actionId,
                cutsceneUp: false,
                modal: boxOpen ? new BodyProgramModalFact(BodyProgramModalKind.Question, "DialogueBox") : BodyProgramModalFact.None,
                actorCanMove: !boxOpen),
        };
        authority.Submit(SingleNodeProgram("plan_700", "water_crop")).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        authority.Submit(SingleNodeProgram("plan_701", "answer_dialogue")).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();

        Node(authority, "plan_701", "n01").State.Should().Be(
            BodyProgramNodeState.Succeeded,
            "an open box is the working precondition of the action that closes it, so the programme that can answer it is not waiting");
        Node(authority, "plan_700", "n01").State.Should().Be(
            BodyProgramNodeState.Pending,
            "the held programme yields the actor rather than minting a durable admission into a wait it cannot end");
        Challenges(authority, "plan_700").Should().BeEmpty();
        executor.Runs.Should().Equal(new[] { "plan_701/n01" });
        reported.Should().Contain(
            line => line.Contains("node_waiting", StringComparison.Ordinal)
                && line.Contains("program=plan_700", StringComparison.Ordinal)
                && line.Contains("held_by=body_program:plan_701", StringComparison.Ordinal),
            "`held_by=body_program:<other>` must stay reachable for a programme that is waiting, or the yield has become a silence");

        // ④ THE YIELD WAS CONDITIONAL, so the reading above is a hold on a WAITING programme and not a pump that has
        // stopped pumping for this one: the same programme starts once the box is gone.
        boxOpen = false;
        controller.Update();
        Node(authority, "plan_700", "n01").State.Should().Be(BodyProgramNodeState.Succeeded);
        executor.Runs.Should().Equal(new[] { "plan_701/n01", "plan_700/n01" });
    }

    private static BodyProgramJournalNode Node(OpenBodyProgramJournalAuthority authority, string programId, string nodeId) =>
        authority.Status(programId).Snapshot!.Nodes.Single(node => node.NodeId == nodeId);

    /// <summary>
    /// Every node this programme's pump ADMITTED, from the journal's own <c>admission_challenge</c> events: the durable
    /// mint is the authority for "this node was started", not the pipe.
    /// </summary>
    private static IReadOnlyList<string?> Challenges(OpenBodyProgramJournalAuthority authority, string programId) =>
        authority.Events(programId, 0, 32).Events.Where(@event => @event.Kind == "admission_challenge")
            .Select(@event => @event.NodeId).ToArray();

    private static OpenBodyProgramJournalAuthority Open() =>
        OpenBodyProgramJournalAuthority.Open(new MemoryStore(), Catalog(), Scope(), static () => Policy(), static () => 10);

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("refill_watering_can", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
        new BodyProgramActionDescriptor("water_crop", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
        new BodyProgramActionDescriptor("answer_dialogue", 1,
            new[] { new BodyProgramArgumentDescriptor("expectedDialogueKey", BodyProgramArgumentKind.String) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
    });

    /// <summary>
    /// Two steps that must happen in order and consume nothing from each other. Every published action claims
    /// `embodied_actor`, so the ordering edge is what makes them one programme rather than a claim conflict.
    /// </summary>
    private static ActionProgramCandidate TwoNodeProgram(string programId) => new(programId, new[]
    {
        new ActionProgramCandidateNode("n01", "refill_watering_can", Coordinates("43"), Array.Empty<string>(), NoBindings()),
        new ActionProgramCandidateNode("n02", "water_crop", Coordinates("43"), Array.Empty<string>(), NoBindings()) { OrderedAfter = new[] { "n01" } },
    });

    private static ActionProgramCandidate SingleNodeProgram(string programId, string actionId) => new(programId, new[]
    {
        actionId == "answer_dialogue"
            ? new ActionProgramCandidateNode("n01", actionId, DialogueAnswer("key-1"), Array.Empty<string>(), NoBindings())
            : new ActionProgramCandidateNode("n01", actionId, Coordinates("44"), Array.Empty<string>(), NoBindings()),
    });

    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> Coordinates(string y) =>
        new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
        {
            ["x"] = new("integer", "43"),
            ["y"] = new("integer", y),
        });

    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> DialogueAnswer(string key) =>
        new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
        {
            ["expectedDialogueKey"] = new("string", key),
        });

    private static IReadOnlyDictionary<string, ActionProgramBinding> NoBindings() =>
        new ReadOnlyDictionary<string, ActionProgramBinding>(new Dictionary<string, ActionProgramBinding>(StringComparer.Ordinal));

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);

    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private static HostAdmissionGrant GrantFor(NodeAdmissionChallenge challenge) => new(
        challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision,
        challenge.PolicyIdentity, challenge.ActionId, challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs,
        $"grant_{challenge.NodeId}_{challenge.NodeAttempt}", "attachment_01", "policy-a");

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

    /// <summary>The Host's half of the seam: every challenge it is asked is granted.</summary>
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

    /// <summary>
    /// The native side, left bound-Running for the first N-1 visits of ONE node so the pass that settles it is a pass of its
    /// own - the frame-level shape of a native action that takes several ticks, and the gap the measured run fell into.
    /// </summary>
    private sealed class SteppingExecutor : IBodyProgramNodeExecutor
    {
        private readonly Dictionary<string, int> visits = new(StringComparer.Ordinal);
        private readonly string programId;
        private readonly string nodeId;
        private readonly int terminalOnVisit;

        public SteppingExecutor(string programId, string nodeId, int terminalOnVisit)
        {
            this.programId = programId;
            this.nodeId = nodeId;
            this.terminalOnVisit = terminalOnVisit;
        }

        public List<string> Runs { get; } = new();

        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            this.Runs.Add($"{grant.ProgramId}/{grant.NodeId}");
            if (!string.Equals(grant.ProgramId, this.programId, StringComparison.Ordinal) || !string.Equals(grant.NodeId, this.nodeId, StringComparison.Ordinal))
                return Succeeded(execution);
            int visit = this.visits.GetValueOrDefault(execution.ExecutionId) + 1;
            this.visits[execution.ExecutionId] = visit;
            return visit >= this.terminalOnVisit ? Succeeded(execution) : null;
        }

        private static BodyProgramTerminalResult Succeeded(NodeExecutionBinding execution) =>
            new(execution, BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt-1", "evidence-1", "postcondition-1");
    }

    private sealed class CountingExecutor : IBodyProgramNodeExecutor
    {
        public List<string> Runs { get; } = new();

        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            this.Runs.Add($"{grant.ProgramId}/{grant.NodeId}");
            return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt-1", "evidence-1", "postcondition-1");
        }
    }
}
