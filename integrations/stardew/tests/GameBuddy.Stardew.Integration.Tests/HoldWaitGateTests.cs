using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Netcode;
using StardewValley;
using StardewValley.Menus;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// GATE, not a test: a hold the Mod may wait out must never be answered as a terminal.
///
/// <para>
/// THE DEFECT THIS EXISTS FOR, measured. `round56`, day 6 at 06:00, the furnace cutscene: the event began at 19:55:53,
/// `equip_tool` was refused `cutscene_active` at 19:55:54.61, the rows were refused from 19:55:56.62, and the world was
/// free again at 19:55:59 - 2.4 s after the last of those refusals. The flat admission refused a condition that clears
/// on its own, `ExecutionAdmission`'s own comment asserted that a cutscene "does not clear inside any bounded window",
/// and `RouteReenteringBodyProgramExecutor` turned every one of those refusals into a dead node (`Rejected` -> `Failed`).
/// Three of three nodes were spent on a hold that had already ended by the time the companion could react.
/// </para>
/// <para>
/// WHY A GATE, AND WHAT ITS POPULATION IS. The set of holds is a closed set the product already declares -
/// <see cref="ExecutionManager.LocalDispositionKind"/>, whose members are the wire vocabulary of
/// <see cref="WorldModel.HoldReasonCode"/> (the two are asserted to be the same set below) - so this walks the union
/// instead of naming the one code that hurt. A kind added tomorrow is examined automatically and fails here before it can
/// reach a run; the question it has to answer is the one every member answers: does this condition clear on its own, and
/// if so, what bounds the wait?
/// </para>
/// <para>
/// THE PROPERTY. <see cref="ExecutionManager.HoldWait"/> is the one classification, and the admission must agree with it:
/// a wait it declares is a request PARKED on the production dispatch path (no receipt, no native effect, answered when
/// the world frees), and a hold it declares un-waitable is refused by the code the one table names. The failure this gate
/// names is <c>transient_condition_consumed_a_plan:&lt;reason&gt;:&lt;nodes&gt;</c>: a condition that clears on its own,
/// answered as terminal. Here the "nodes" are the population member, because a node is where that answer lands.
/// </para>
/// <para>
/// WHAT IS NOT IN THIS POPULATION, and where it is measured instead: the actor's OWN in-flight work
/// (<c>body_owned_by_*</c>), which is a queue owned by <c>ExecutionAdmission.RejectBodyOwned</c> rather than a world
/// condition - `HeldRequestAbsorptionTests` drives the queued pair (movement, activity) to a park and the committed ones
/// (travel, ride, overnight) to an immediate refusal. A code neither table declares cannot reach a request.
/// </para>
/// </summary>
public sealed class HoldWaitGateTests
{
    private readonly ITestOutputHelper output;

    public HoldWaitGateTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// Every kind the admission can project, driven through the production dispatch path, compared with the wait the one
    /// classification declares for it.
    /// </summary>
    [Fact]
    public void EveryHoldTheAdmissionCanName_IsWaitedOutExactlyWhenItsClassificationSaysSo()
    {
        // ONE VOCABULARY, TWO READERS: the admission projects `ActorDispositionKind` onto `LocalDispositionKind`, and the
        // wire code comes from the former while the wait comes from the latter. If either set grows a member the other
        // does not have, the code and the wait stop describing one fact - so the coupling is asserted, not assumed.
        Enum.GetNames<ExecutionManager.LocalDispositionKind>().Should().BeEquivalentTo(
            Enum.GetNames<ActorDispositionKind>(),
            "the hold vocabulary and the admission projection are one closed set; a member on one side only means a condition whose code and wait disagree");

        var rows = new List<(string Kind, string? Code, BodyHoldWait? Wait, string Outcome)>();
        foreach (ExecutionManager.LocalDispositionKind kind in Enum.GetValues<ExecutionManager.LocalDispositionKind>())
        {
            using var world = WorldShape.For(kind);
            DispatchResult result = world.Dispatch();
            string? code = kind == ExecutionManager.LocalDispositionKind.Idle
                ? null
                : WorldModel.HoldReasonCode(Enum.Parse<ActorDispositionKind>(kind.ToString()));
            rows.Add((kind.ToString(), code, ExecutionManager.HoldWait(kind), result.Outcome));
        }

        // Every member is EXAMINED, and the print says how many: "0 violations" over an empty population agrees with
        // itself.
        rows.Should().HaveCount(
            Enum.GetValues<ExecutionManager.LocalDispositionKind>().Length,
            "one row per kind - a population that shrank is a gate that stopped looking");

        // COLLECTED, then printed, then judged - so a red run says the population and the counts before it says the
        // verdict, and the failure names the drifting member rather than "expected true, got false".
        var violations = new List<string>();
        foreach ((string kind, string? code, BodyHoldWait? wait, string outcome) in rows)
        {
            if (code is null)
            {
                if (outcome != "dispatched") violations.Add($"idle_body_answered_as:{outcome}");
                continue;
            }

            if (wait is not null)
            {
                if (outcome != "parked") violations.Add($"transient_condition_consumed_a_plan:{code}:{kind}");
                continue;
            }

            if (outcome != $"refused:{code}") violations.Add($"terminal_hold_answered_as:{outcome}:expected:{code}");
        }

        // THE ONE FACT THE TWO LAYERS USED TO SPELL DIFFERENTLY: the pump's START/DEFERRAL gate and the flat admission
        // read the same cutscene, so they must name the same wait - it is one enum, and this is the assertion that keeps
        // it one.
        string bodyOwning = FarmhandActionCatalog.Registrations
            .Select(registration => registration.ActionId)
            .First(actionId => !FarmhandActionCatalog.IsModalResolving(actionId));
        BodyProgramHold? cutsceneHold = BodyProgramDispatchGate.HoldOf(bodyOwning, cutsceneUp: true, BodyProgramModalFact.None, actorCanMove: false);
        cutsceneHold.Should().NotBeNull("a cutscene holds every body-owning action");
        cutsceneHold!.Value.Wait.Should().Be(
                ExecutionManager.HoldWait(ExecutionManager.LocalDispositionKind.Event),
                "the body-program pump and the flat admission answer one question about one cutscene; two answers is how the same event was 'waited out' by one layer and 'terminal' at the other");
        BodyProgramHold? transientHold = BodyProgramDispatchGate.HoldOf(bodyOwning, cutsceneUp: false, BodyProgramModalFact.None, actorCanMove: false);
        transientHold.Should().NotBeNull("a body lock holds every body-owning action");
        transientHold!.Value.Wait.Should().Be(ExecutionManager.HoldWait(ExecutionManager.LocalDispositionKind.Transient));

        int transient = rows.Count(row => row.Wait is not null);
        int terminal = rows.Count(row => row.Code is not null && row.Wait is null);
        int transientTreatedAsTerminal = rows.Count(row => row.Wait is not null && row.Outcome != "parked");
        string Names(Func<(string Kind, string? Code, BodyHoldWait? Wait, string Outcome), bool> predicate) =>
            string.Join(",", rows.Where(predicate).Select(row => row.Code ?? row.Kind));

        this.output.WriteLine(
            $"refusal codes examined {rows.Count(row => row.Code is not null)} · transient {transient} ({Names(row => row.Wait is not null)}) · "
            + $"terminal {terminal} ({Names(row => row.Code is not null && row.Wait is null)}) · "
            + $"transient-treated-as-terminal {transientTreatedAsTerminal} ({Names(row => row.Wait is not null && row.Outcome != "parked")}) · "
            + $"conditions examined {rows.Count} · exempt {rows.Count - transient - terminal} (idle: not a hold)");

        transientTreatedAsTerminal.Should().Be(
            0,
            "a hold that clears on its own may not be answered as a terminal, or the request - and the plan it carried - is spent on a condition that ended by itself");
        transient.Should().BeGreaterThan(0, "the population must contain the waits this gate exists to measure");
        violations.Should().BeEmpty(
            "transient_condition_consumed_a_plan:<reason>:<nodes> - one entry per member of the closed hold set that is answered against its own classification; a kind added tomorrow is examined here automatically");
    }

    // ---- the world shapes, one per kind --------------------------------------------

    /// <summary>
    /// One world the admission can meet, set on the real <see cref="Game1"/> statics the one fact reader reads, restored
    /// on dispose - the probe convention the suite's other game-state cases use.
    /// </summary>
    private sealed class WorldShape : IDisposable
    {
        private const long ActorId = 1001;

        private static readonly FieldInfo MenuField =
            typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;

        private readonly bool eventUpBefore = Game1.eventUp;
        private readonly bool dialogueUpBefore = Game1.dialogueUp;
        private readonly int timeOfDayBefore = Game1.timeOfDay;
        private readonly object? menuBefore = MenuField.GetValue(null);

        private WorldShape(ExecutionManager.LocalDispositionKind kind)
        {
            MenuField.SetValue(null, null);
            Game1.eventUp = false;
            Game1.dialogueUp = false;
            Game1.timeOfDay = 1200;
            switch (kind)
            {
                case ExecutionManager.LocalDispositionKind.Event:
                    Game1.eventUp = true;
                    break;
                case ExecutionManager.LocalDispositionKind.Modal:
                    MenuField.SetValue(null, DialogueBox());
                    Game1.dialogueUp = true;
                    break;
                case ExecutionManager.LocalDispositionKind.PassOut:
                    Game1.timeOfDay = WorldModel.PassOutDayEndTime;
                    break;
            }

            this.ExecutionManager = CreateManager(kind);
        }

        internal ExecutionManager ExecutionManager { get; }

        internal static WorldShape For(ExecutionManager.LocalDispositionKind kind) => new(kind);

        /// <summary>
        /// The production dispatch path: an authenticated bridge request through the router, the handler asking the
        /// shared admission at the one place every real handler does, and the bridge holding what the admission parks.
        /// </summary>
        internal DispatchResult Dispatch()
        {
            var handler = new AdmittingActionHandler(this.ExecutionManager);
            var router = new FarmhandActionRouter();
            router.Register(FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == "move_to_tile"), handler);
            var scope = new BridgeScope("stardew", "save-gate", "world-gate", ActorId.ToString(), "companion-gate");
            const string token = "hold_wait_gate_token_0123456789";
            var session = new BridgeSession(this.ExecutionManager, router, scope, token, () => Publication());
            session.TryAuthenticate(1, Hello(scope, token), out _, out string authReason).Should().BeTrue(authReason);
            var request = new BridgeEnvelope<BridgeExecutionRequest>(
                BridgeProtocol.Version,
                "msg_gate",
                "corr_gate",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                scope,
                "execution_request",
                new BridgeExecutionRequest(
                    "req_gate",
                    "idemp_gate",
                    "move_to_tile",
                    new BridgeExecutionArgs { X = 5, Y = 6 },
                    this.ExecutionManager.Revision,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000));
            session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? answer, out string reason)
                .Should().BeTrue(reason);
            if (answer is null)
            {
                reason.Should().Be(
                    ExecutionManager.HeldRequestMarker,
                    "a request the bridge holds answers nothing, and the marker is what says so");
                handler.Invocations.Should().Be(0, "a held request has not run");
                return new DispatchResult("parked", handler.Invocations);
            }
            return new DispatchResult(
                answer.Payload.State == "rejected" ? $"refused:{answer.Payload.ReasonCode}" : "dispatched",
                handler.Invocations);
        }

        public void Dispose()
        {
            MenuField.SetValue(null, this.menuBefore);
            Game1.eventUp = this.eventUpBefore;
            Game1.dialogueUp = this.dialogueUpBefore;
            Game1.timeOfDay = this.timeOfDayBefore;
        }

        private static ExecutionManager CreateManager(ExecutionManager.LocalDispositionKind kind)
        {
            var executions = new ExecutionManager(new DummyMonitor(), () => Publication(), executionScope: null);
            Farmer actor = CreateActor(
                canMove: kind is not (ExecutionManager.LocalDispositionKind.Event or ExecutionManager.LocalDispositionKind.PassOut or ExecutionManager.LocalDispositionKind.Modal),
                usingTool: kind == ExecutionManager.LocalDispositionKind.Transient);
            executions.SetTestActorResolver(() => actor);
            return executions;
        }

        private static FarmhandCapabilityPublication Publication() => FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });

        private static BridgeEnvelope<BridgeHello> Hello(BridgeScope scope, string token) =>
            new(BridgeProtocol.Version, "msg_hello", "corr_hello", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));

        private static Farmer CreateActor(bool canMove, bool usingTool)
        {
            Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            typeof(Farmer)
                .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, new NetLong(ActorId));
            actor.CanMove = canMove;
            actor.freezePause = 0;
            typeof(Farmer)
                .GetField("usingTool", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, new NetBool(usingTool));
            typeof(Farmer)
                .GetField("netStamina", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, new NetFloat(270f));
            typeof(Farmer)
                .GetField("toolPower", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, new NetInt(0));
            ProbeFarmerSprite.Attach(actor);
            return actor;
        }

        private static DialogueBox DialogueBox() =>
            (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
    }

    /// <summary>What the production path answered, and whether the native effect ran.</summary>
    private sealed record DispatchResult(string Outcome, int Invocations);

    /// <summary>
    /// The one thing every real handler does at the same place: ask the shared admission, and return its answer instead
    /// of doing the native work. The native work here is a counted invocation, so "nothing was spent" is measured.
    /// </summary>
    private sealed class AdmittingActionHandler : IFarmhandActionHandler
    {
        private readonly ExecutionManager executions;

        internal AdmittingActionHandler(ExecutionManager executions) => this.executions = executions;

        internal int Invocations { get; private set; }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatch
                && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                ? bound
                : Guid.NewGuid().ToString("N");
            object? admission = typeof(ExecutionManager)
                .GetMethod("AdmitExecution", BindingFlags.NonPublic | BindingFlags.Instance)!
                .Invoke(this.executions, new object?[]
                {
                    request.RequestId,
                    executionId,
                    request.DeadlineMs,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ExecutionManager.AdmissionActionabilityProfile.General,
                    FarmhandActionCatalog.OrdinaryActionCeilingMs,
                });
            if (admission is LocalExecutionReceipt admissionAnswer)
                return admissionAnswer;

            this.Invocations++;
            LocalExecutionReceipt receipt = new(
                executionId,
                request.RequestId,
                ExecutionState.Accepted,
                "accepted",
                ledger.CurrentRevision,
                $"tile={request.Args.X},{request.Args.Y}");
            ledger.Remember(receipt);
            ledger.AddTrace(receipt);
            return receipt;
        }
    }
}
