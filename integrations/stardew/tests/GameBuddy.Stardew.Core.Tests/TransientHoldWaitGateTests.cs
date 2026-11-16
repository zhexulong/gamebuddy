using System.Collections.ObjectModel;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// GATE, not a test: a refusal that CLEARS ON ITS OWN must never settle a program node.
///
/// <para>
/// THE DEFECT THIS EXISTS FOR, measured. `round56`, day 6 at 06:00, the furnace cutscene: one clear-and-plant program
/// submitted three nodes, the pump deferred each of them for its cadence window (two seconds), dispatched them into the
/// running event, and the world answered `cutscene_active` to every one. Four row receipts and one node receipt later
/// all three nodes were settled and the plan was gone - while the world was free again four seconds after the first
/// refusal. The plan was spent on a condition that had already cleared by the time the companion re-planned.
/// </para>
/// <para>
/// WHY A GATE. The population is the CATALOG: every action, against every world shape the dispatch gate answers for. A
/// property checked against one action and one cutscene is a test of the day's scenario; the same class of defect
/// arrives again the first time a new hold is named, so the classification is asserted for every action the product
/// publishes and every code the gate can mint.
/// </para>
/// <para>
/// THE PROPERTY. Every hold the gate reports is classified exactly once, as a hold that clears inside the flat
/// admission's retry window or as one that clears only when the world says so (<see cref="BodyHoldWait"/>), and
/// a node that meets the second kind is neither dispatched nor settled until its own watchdog runs out. A code whose
/// own evidence says "wait for the world" and which the pump still spends is the failure this gate names:
/// <c>transient_condition_consumed_a_plan:&lt;reason&gt;:&lt;nodes&gt;</c>.
/// </para>
/// </summary>
public sealed class TransientHoldWaitGateTests
{
    private readonly ITestOutputHelper output;

    public TransientHoldWaitGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>Every action the product publishes, plus the modal-resolving family its own catalog declares.</summary>
    private static string[] CatalogActions() => FarmhandActionCatalog.Registrations
        .Select(registration => registration.ActionId)
        .OrderBy(actionId => actionId, StringComparer.Ordinal)
        .ToArray();

    /// <summary>Every world shape the dispatch gate answers for, named so a failure says which one.</summary>
    private static IEnumerable<(string Shape, bool CutsceneUp, BodyProgramModalFact Modal, bool CanMove)> WorldShapes()
    {
        yield return ("cutscene", true, BodyProgramModalFact.None, false);
        yield return ("transient_lock", false, BodyProgramModalFact.None, false);
        yield return ("question_box", false, new BodyProgramModalFact(BodyProgramModalKind.Question, "DialogueBox"), false);
        yield return ("plain_dialogue", false, new BodyProgramModalFact(BodyProgramModalKind.PlainDialogue, "DialogueBox"), false);
        yield return ("shop_counter", false, new BodyProgramModalFact(BodyProgramModalKind.Shop, "ShopMenu"), false);
        yield return ("operation_menu", false, new BodyProgramModalFact(BodyProgramModalKind.OperationMenu, "CarpenterMenu"), false);
        yield return ("unaudited_menu", false, new BodyProgramModalFact(BodyProgramModalKind.Menu, "LevelUpMenu"), false);
        yield return ("free", false, BodyProgramModalFact.None, true);
    }

    /// <summary>The reason code a hold's own evidence names (`held_by=&lt;code&gt;`), or null when it names none.</summary>
    private static string? CodeOf(BodyProgramHold hold)
    {
        foreach (string field in hold.Evidence.Split(';'))
        {
            int equals = field.IndexOf('=', StringComparison.Ordinal);
            if (equals > 0 && field[..equals] == "held_by") return field[(equals + 1)..];
        }
        return null;
    }

    /// <summary>
    /// A hold that settles a node without a wait is one whose own evidence tells the reader to WAIT for the world, or one
    /// that is simply not a hold at all. Both readings are the Mod's, and they must agree.
    /// </summary>
    private static bool EvidenceSaysWaitForTheWorld(string evidence) =>
        evidence.Contains("next_step=wait_for_event_to_end", StringComparison.Ordinal)
        || evidence.Contains("next_step=wait_for_event_to_advance", StringComparison.Ordinal);

    [Fact]
    public void EveryRefusalTheGateCanMint_IsClassifiedTransientOrTerminal_AndTheTwoReadingsAgree()
    {
        string[] actions = CatalogActions();
        actions.Should().NotBeEmpty("the population is the published catalog; an empty one examines nothing and agrees with itself");

        var byCode = new Dictionary<string, (BodyHoldWait Wait, string Shape)>(StringComparer.Ordinal);
        int examined = 0;
        var transient = new List<string>();
        var terminal = new List<string>();
        var held = new List<string>();

        foreach (string actionId in actions)
        foreach ((string shape, bool cutsceneUp, BodyProgramModalFact modal, bool canMove) in WorldShapes())
        {
            BodyProgramHold? hold = BodyProgramDispatchGate.HoldOf(actionId, cutsceneUp, modal, canMove);
            examined++;
            if (shape == "free")
            {
                hold.Should().BeNull($"a free body and an empty screen hold nothing:{actionId}");
                continue;
            }
            if (modal.IsMounted)
            {
                // A mounted modal is the modal-resolving family's WORKING PRECONDITION, and a hold against everything
                // else. The exemption is the catalog's own declaration, so this reads it rather than listing it.
                hold.HasValue.Should().Be(
                    !FarmhandActionCatalog.IsModalResolving(actionId),
                    $"modal_exemption_is_the_catalog_declaration:{actionId}:{shape}");
                if (!hold.HasValue) continue;
            }
            hold.Should().NotBeNull($"every_hold_shape_holds_a_body_owning_action:{actionId}:{shape}");
            string? code = CodeOf(hold!.Value);
            code.Should().NotBeNull($"a_hold_that_names_nobody_is_a_refusal_nobody_can_act_on:{actionId}:{shape}");

            // ONE FACT, ONE SPELLING: the same code may not be declared both ways because a different modal was mounted.
            if (byCode.TryGetValue(code!, out (BodyHoldWait Wait, string Shape) seen))
                seen.Wait.Should().Be(hold.Value.Wait, $"one_code_one_classification:{code}:{shape} vs {seen.Shape}");
            else
                byCode[code!] = (hold.Value.Wait, shape);

            if (!held.Contains(code!)) held.Add(code!);
        }

        foreach ((string code, (BodyHoldWait wait, string shape)) in byCode.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            BodyProgramHold sample = BodyProgramDispatchGate.HoldOf(actions[0], shape == "cutscene", ModalFor(shape), false)!.Value;
            bool saysWait = EvidenceSaysWaitForTheWorld(sample.Evidence);
            (wait == BodyHoldWait.RequestDeadline).Should().Be(
                saysWait,
                $"the classification and the evidence are two readings of one fact, so a code whose evidence tells the reader to wait for the world must be waited out and no other may be:{code}:{sample.Evidence}");
            if (wait == BodyHoldWait.RequestDeadline) transient.Add(code);
            else terminal.Add(code);
        }

        transient.Should().Contain("cutscene_active", "the measured code of the round56 defect must be in the population");
        output.WriteLine(
            $"refusal codes examined {examined} · transient {transient.Count} ({string.Join(",", transient)}) · "
            + $"terminal {terminal.Count} ({string.Join(",", terminal)}) · holds named {held.Count}");
    }

    /// <summary>
    /// THE MEASURED CASE. A cutscene that outlives the pump's cadence window must not spend the node: no dispatch, no
    /// settlement, nothing consumed - and the moment the event ends the same node runs, so the wait is a wait and not a
    /// pump that stopped pumping.
    /// </summary>
    [Fact]
    public void ACutsceneThatOutlivesTheCadenceWindow_DoesNotConsumeThePlan()
    {
        var clock = new TimeBox { Value = 10 };
        OpenBodyProgramJournalAuthority authority = Open(clock);
        var admission = new ImmediateAdmissionTransport();
        var world = new WorldNodeExecutor { HeldReasonCode = "cutscene_active" };
        var reported = new List<string>();
        var controller = new FarmhandBodyProgramController(authority, admission, world)
        {
            Diagnostics = reported.Add,
            NowMs = () => clock.Value,
            HoldOf = actionId => BodyProgramDispatchGate.HoldOf(
                actionId,
                cutsceneUp: world.HeldReasonCode is not null,
                modal: BodyProgramModalFact.None,
                actorCanMove: world.HeldReasonCode is null),
        };
        authority.Submit(SingleNodeProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        // The cadence window the pump used to spend is ninety ticks; the cutscene here outlives any such window.
        for (int tick = 0; tick < 400; tick += 1) controller.Update();

        BodyProgramStatusSnapshot waiting = authority.Status("program").Snapshot!;
        waiting.Nodes.Single().State.Should().Be(
            BodyProgramNodeState.AwaitingHostAdmission,
            "transient_condition_consumed_a_plan:cutscene_active:node-1 - a cutscene that has not ended is a wait, and dispatching into it spends the node's one attempt");
        world.Runs.Should().Be(0, "nothing may be dispatched into a hold the pump knows is still in force");
        waiting.State.Should().Be(BodyProgramState.Active, "the program is still the plan the companion wrote");

        // Once per hold, and it names the hold and the instant the wait would end - the companion's own account of why
        // nothing has happened yet.
        reported.Should().ContainSingle(line => line.Contains("node_waiting_out_hold", StringComparison.Ordinal));
        reported.Should().Contain(line => line.Contains("held_by=cutscene_active;next_step=wait_for_event_to_end", StringComparison.Ordinal));
        reported.Should().Contain(line => line.Contains("deadlineMs=1010", StringComparison.Ordinal));

        // FALSIFIER: the event ends and the SAME node runs on the SAME admission - so the wait above is the gate
        // holding, not a node that can no longer run.
        world.HeldReasonCode = null;
        controller.Update();
        world.Runs.Should().Be(1);
        authority.Status("program").Snapshot!.Nodes.Single().State.Should().Be(BodyProgramNodeState.Succeeded);
    }

    /// <summary>
    /// THE WAIT IS BOUNDED, AND ITS END NAMES WHAT IT WAITED ON. The bound is the node's own watchdog - the instant its
    /// admission can no longer be consumed - and a receipt that said only `deadline_expired` would leave the companion
    /// with no way to know a cutscene was what held her for the whole window.
    /// </summary>
    [Fact]
    public void TheWaitEndsAtTheNodesWatchdog_AndTheReceiptNamesTheHold()
    {
        var clock = new TimeBox { Value = 10 };
        OpenBodyProgramJournalAuthority authority = Open(clock);
        var admission = new ImmediateAdmissionTransport();
        var world = new WorldNodeExecutor { HeldReasonCode = "cutscene_active" };
        var controller = new FarmhandBodyProgramController(authority, admission, world)
        {
            NowMs = () => clock.Value,
            HoldOf = actionId => BodyProgramDispatchGate.HoldOf(actionId, cutsceneUp: true, modal: BodyProgramModalFact.None, actorCanMove: false),
        };
        authority.Submit(SingleNodeProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        controller.Update();
        BodyProgramJournalNode waiting = authority.Status("program").Snapshot!.Nodes.Single();
        waiting.State.Should().Be(BodyProgramNodeState.AwaitingHostAdmission);
        long watchdogMs = waiting.DerivedDeadlineMs!.Value;

        // Past the watchdog with the event still running: the wait ends, and it ends naming the hold.
        clock.Value = watchdogMs + 1;
        controller.Update();

        BodyProgramJournalNode settled = authority.Status("program").Snapshot!.Nodes.Single();
        settled.State.Should().Be(BodyProgramNodeState.Rejected);
        settled.RejectionCode.Should().Be("deadline_expired");
        settled.RefusalDetail.Should().Be(
            "held_by=cutscene_active;next_step=wait_for_event_to_end",
            "the hold is the fact the companion needs; the code alone says only that time passed");
        world.Runs.Should().Be(0, "a watchdog that ran out is not a licence to dispatch into the hold anyway");
    }

    /// <summary>
    /// FALSIFIER for the gate above. A hold that ends inside the flat admission's own retry window is NOT waited out to
    /// the watchdog - the pump spends the cadence window and dispatches, because by then the world really is free. Same
    /// shape as the cutscene (non-modal, named, waited for), a different classification: without this case the gate
    /// would pass over a pump that simply stopped dispatching.
    /// </summary>
    [Fact]
    public void AHoldThatEndsInsideTheRetryWindow_StillSpendsTheCadenceWindowAndTheNode()
    {
        var clock = new TimeBox { Value = 10 };
        OpenBodyProgramJournalAuthority authority = Open(clock);
        var admission = new ImmediateAdmissionTransport();
        var world = new WorldNodeExecutor { HeldReasonCode = "transient_busy" };
        var controller = new FarmhandBodyProgramController(authority, admission, world)
        {
            NowMs = () => clock.Value,
            HoldOf = actionId => BodyProgramDispatchGate.HoldOf(
                actionId,
                cutsceneUp: false,
                modal: BodyProgramModalFact.None,
                actorCanMove: false),
        };
        authority.Submit(SingleNodeProgram()).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        for (int tick = 0; tick < 400; tick += 1) controller.Update();

        world.Runs.Should().Be(
            1,
            "a retry-window hold is dispatched after the cadence window, which is what the world's own parking window is for");
        authority.Status("program").Snapshot!.Nodes.Single().State.Should().Be(
            BodyProgramNodeState.Failed,
            "the world's refusal is the answer once the wait the hold asked for has been spent");
    }

    private static BodyProgramModalFact ModalFor(string shape) => shape switch
    {
        "question_box" => new BodyProgramModalFact(BodyProgramModalKind.Question, "DialogueBox"),
        "plain_dialogue" => new BodyProgramModalFact(BodyProgramModalKind.PlainDialogue, "DialogueBox"),
        "shop_counter" => new BodyProgramModalFact(BodyProgramModalKind.Shop, "ShopMenu"),
        "operation_menu" => new BodyProgramModalFact(BodyProgramModalKind.OperationMenu, "CarpenterMenu"),
        "unaudited_menu" => new BodyProgramModalFact(BodyProgramModalKind.Menu, "LevelUpMenu"),
        _ => BodyProgramModalFact.None,
    };

    private static OpenBodyProgramJournalAuthority Open(TimeBox clock) =>
        OpenBodyProgramJournalAuthority.Open(new MemoryStore(), Catalog(), Scope(), () => Policy(), () => clock.Value);

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("machine_inspect", 1,
            new[]
            {
                new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer),
                new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer),
            },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
    });

    private static ActionProgramCandidate SingleNodeProgram() => new("program", new[]
    {
        new ActionProgramCandidateNode("node-1", "machine_inspect",
            new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(
                new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
                {
                    ["x"] = new("integer", "1"),
                    ["y"] = new("integer", "1"),
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
        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);
        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null) { this.value = encodedState; return true; }
    }

    private sealed class ImmediateAdmissionTransport : IBodyProgramAdmissionTransport
    {
        private readonly Dictionary<(string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt), HostAdmissionGrant> grants = new();
        public long AttachmentGeneration => 1;
        public void Send(NodeAdmissionChallenge challenge) =>
            this.grants[(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt)] = GrantFor(challenge);
        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt)
        {
            this.grants.TryGetValue((programId, nodeId, nodeAttempt, admissionAttempt), out HostAdmissionGrant? grant);
            return grant is null ? null : new BodyNodeAdmissionGrantedResult(grant);
        }
    }

    /// <summary>
    /// The WORLD, not the type under test: while <see cref="HeldReasonCode"/> is set every dispatch is refused with that
    /// code, exactly as the flat admission answers a held actor; with it cleared the same node succeeds. The pump's
    /// behaviour is what the gate asserts, so the boundary it talks to is real enough to refuse.
    /// </summary>
    private sealed class WorldNodeExecutor : IBodyProgramNodeExecutor
    {
        public string? HeldReasonCode { get; set; }
        public int Runs { get; private set; }
        public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
        {
            this.Runs++;
            if (this.HeldReasonCode is { } code)
                return new BodyProgramTerminalResult(
                    execution, BodyProgramNodeOutcome.Failed, Array.Empty<RuntimeFact>(), null, null, null, code, null, "held_by=" + code);
            return new BodyProgramTerminalResult(
                execution, BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(), "receipt-1", "evidence-1", "postcondition-1");
        }
    }
}
