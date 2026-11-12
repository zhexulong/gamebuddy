using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Threading;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Netcode;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The transient body hold is absorbed by the Mod, not paid for by the Agent's round-trip
/// (design/research/action-hold-absorption.md, 2026-10-19). A request that arrives 49-154 ms after the
/// previous one settled finds the actor still in a tool swing, a harvest animation or a warp transition, and
/// the named refusal that answered it cost a whole model turn (measured: 12.1 s, 4.7 s and 2.6 s) to
/// re-issue the very same thing - while the Mod already knew the hold clears inside
/// <see cref="WorldModel.TransientRetryWindowMs"/>. Each pin below drives the real path on a probe actor:
/// authenticated bridge request, shared admission, parked wait, dispatch.
///
/// <para>
/// The same absorption covers the OTHER hold the actor's own work creates: an in-flight execution that owns the
/// body. Measured 19:31:39 - a request arrived while a background `pickup_item` held the body, was answered
/// `body_owned_by_activity`, and the run went quiet. A collision with the actor's own in-flight work is a queue,
/// not a failure; only a hold this bridge must not wait for (another lineage's journalled admission, or an owner that
/// outlives the bounded window) keeps the named refusal.
/// </para>
/// </summary>
public sealed class HeldRequestAbsorptionTests
{
    [Fact]
    public void ATransientHoldParksTheRequest_AndTheFreedBodyDispatchesItExactlyOnce_WithHeldMs()
    {
        Absorption absorption = Park("admit", canMove: false, usingTool: true);

        absorption.Session.TryExecute(1, absorption.Request, out BridgeEnvelope<BridgeReceipt>? parked, out string parkedReason)
            .Should().BeTrue(parkedReason);
        parked.Should().BeNull("the Mod holds the request until the body frees: there is nothing to answer yet");
        parkedReason.Should().Be(ExecutionManager.HeldRequestMarker);
        absorption.Handler.Invocations.Should().Be(0, "the admission parked the request instead of starting the native effect");
        absorption.Executions.TryGetReceipt(absorption.Request.Payload.RequestId, out _)
            .Should().BeFalse("a wait is not a dispatch: no receipt exists until the action starts");

        absorption.FreeTheBody();
        for (int tick = 0; tick < 3; tick++)
            absorption.Executions.PumpHeldRequests();

        absorption.Handler.Invocations.Should().Be(1, "the freed body dispatches the request exactly once");
        BridgeEnvelope<BridgeReceipt> answer = absorption.TakeAnswer();
        answer.CorrelationId.Should().Be(absorption.Request.CorrelationId, "the answer belongs to the request that waited");
        answer.Payload.State.Should().Be("accepted");
        answer.Payload.ExecutionId.Should().Be(absorption.Handler.ExecutionId!);
        // The hold is EVIDENCE, not a mystery: the dispatch says how long it waited (the Mod's evidence
        // string travels as the `detail` field of the wire's evidence map).
        answer.Payload.Evidence!["detail"].Should().MatchRegex(@"(^|;)held_ms=\d+$");
        absorption.Executions.TryGetReceipt(absorption.Request.Payload.RequestId, out LocalExecutionReceipt stored)
            .Should().BeTrue();
        stored.Evidence.Should().Be(answer.Payload.Evidence!["detail"],
            "the answer is the receipt the ledger stored and published, not a second story");

        // Answered once and only once: another tick finds nothing parked and sends nothing.
        absorption.Executions.PumpHeldRequests();
        absorption.Handler.Invocations.Should().Be(1);
        absorption.Session.TryDequeueHeldExecutionResponse(out _, out _).Should().BeFalse();
    }

    [Fact]
    public void AnExpiredHold_AnswersTheSameNamedRefusalAsOnArrival()
    {
        Absorption absorption = Park("expired", canMove: false, usingTool: true);
        absorption.Session.TryExecute(1, absorption.Request, out _, out string parkedReason).Should().BeTrue(parkedReason);
        parkedReason.Should().Be(ExecutionManager.HeldRequestMarker);

        Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
        absorption.Executions.PumpHeldRequests();

        absorption.Handler.Invocations.Should().Be(0, "an expired hold never dispatches: the window is the whole promise");
        BridgeEnvelope<BridgeReceipt> answer = absorption.TakeAnswer();
        answer.CorrelationId.Should().Be(absorption.Request.CorrelationId);
        answer.Payload.State.Should().Be("rejected");
        // The SAME named refusal as today, byte for byte: the code and the evidence the one WorldModel
        // authority produces for this very hold on arrival.
        ActorWorldFacts facts = WorldModel.ReadFacts(absorption.Actor);
        (string holdCode, string holdEvidence) =
            WorldModel.DescribeCurrentBodyHold(WorldModel.Classify(facts), facts, absorption.Actor.CanMove);
        answer.Payload.ReasonCode.Should().Be("transient_busy");
        answer.Payload.ReasonCode.Should().Be(holdCode);
        answer.Payload.Evidence!["detail"].Should().Be(holdEvidence);
    }

    [Fact]
    public void AHoldThatCannotClearItself_StillRefusesImmediately()
    {
        Absorption absorption = Park("cutscene", canMove: false, usingTool: false);
        bool eventUpBefore = Game1.eventUp;
        try
        {
            Game1.eventUp = true;
            absorption.Session.TryExecute(1, absorption.Request, out BridgeEnvelope<BridgeReceipt>? answer, out string reason)
                .Should().BeTrue(reason);
            answer.Should().NotBeNull("a cutscene cannot clear inside a bounded window, so it is refused rather than parked");
            answer!.Payload.State.Should().Be("rejected");
            answer.Payload.ReasonCode.Should().Be("cutscene_active");
        }
        finally
        {
            Game1.eventUp = eventUpBefore;
        }

        absorption.Handler.Invocations.Should().Be(0);
        absorption.Executions.PumpHeldRequests();
        absorption.Session.TryDequeueHeldExecutionResponse(out _, out _).Should().BeFalse("nothing was parked");
    }

    [Fact]
    public void AnActivityHoldParksTheRequest_AndTheFinishedPickupDispatchesItExactlyOnce()
    {
        Absorption absorption = Park("pickup", canMove: true, usingTool: false);
        absorption.OwnTheBody("activeItemPickup", new LocalItemPickupSpec(
            "exec_pickup", "req_pickup", "ProbeFarm", 3, 9, "ground_1", "(O)24", 1, 0, 1, DeadlineMs));

        absorption.Session.TryExecute(1, absorption.Request, out BridgeEnvelope<BridgeReceipt>? parked, out string parkedReason)
            .Should().BeTrue(parkedReason);
        parked.Should().BeNull("the Mod holds the request while the actor finishes work it started itself");
        parkedReason.Should().Be(ExecutionManager.HeldRequestMarker);
        absorption.Handler.Invocations.Should().Be(0, "the pickup owns the body: nothing may start yet");

        // A tick passes while the pickup is still running: the wait continues and answers nothing.
        absorption.Executions.PumpHeldRequests();
        absorption.Handler.Invocations.Should().Be(0);
        absorption.Session.TryDequeueHeldExecutionResponse(out _, out _).Should().BeFalse();

        absorption.ReleaseTheBody("activeItemPickup");
        absorption.Executions.PumpHeldRequests();

        absorption.Handler.Invocations.Should().Be(1, "the freed body dispatches the queued request exactly once");
        BridgeEnvelope<BridgeReceipt> answer = absorption.TakeAnswer();
        answer.CorrelationId.Should().Be(absorption.Request.CorrelationId);
        answer.Payload.State.Should().Be("accepted");
        answer.Payload.Evidence!["detail"].Should().MatchRegex(@"(^|;)held_ms=\d+$");
    }

    [Fact]
    public void AnActivityHoldThatOutlivesTheWindow_AnswersTheNamedWaitCarryingItsOwner()
    {
        Absorption absorption = Park("pickup-expired", canMove: true, usingTool: false);
        absorption.OwnTheBody("activeItemPickup", new LocalItemPickupSpec(
            "exec_pickup", "req_pickup", "ProbeFarm", 3, 9, "ground_1", "(O)24", 1, 0, 1, DeadlineMs));
        absorption.Session.TryExecute(1, absorption.Request, out _, out string parkedReason).Should().BeTrue(parkedReason);
        parkedReason.Should().Be(ExecutionManager.HeldRequestMarker);

        Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
        absorption.Executions.PumpHeldRequests();

        absorption.Handler.Invocations.Should().Be(0, "the owner never finished inside the window");
        BridgeEnvelope<BridgeReceipt> answer = absorption.TakeAnswer();
        answer.Payload.State.Should().Be("rejected");
        // The wait NAMES what it waited for, so the Agent reads a hold rather than an unexplained failure.
        answer.Payload.ReasonCode.Should().Be("waiting_for_body:body_owned_by_activity");
        // ...and the owner's own action id travels on the receipt's existing evidence, not on a new wire field.
        answer.Payload.Evidence!["detail"].Should()
            .Contain("owner_execution_id=exec_pickup")
            .And.Contain("owner_action=pickup_item");
    }

    [Fact]
    public void AHoldThisBridgeMustNotWaitFor_StillRefusesImmediately()
    {
        // A map transition outlives the bounded window every time, so parking behind it would only delay the same
        // named refusal. It keeps answering on arrival, and nothing is queued.
        Absorption absorption = Park("travel", canMove: true, usingTool: false);
        absorption.OwnTheBody("activeTravel", new LocalTravelSpec(
            "exec_travel", "req_travel", "enter_exit", "ProbeFarm", 3, 9, "ProbeFarmHouse", 5, 5, 1, DeadlineMs));

        absorption.Session.TryExecute(1, absorption.Request, out BridgeEnvelope<BridgeReceipt>? answer, out string reason)
            .Should().BeTrue(reason);
        answer.Should().NotBeNull("this owner is refused rather than waited for");
        answer!.Payload.State.Should().Be("rejected");
        answer.Payload.ReasonCode.Should().Be("body_owned_by_travel");
        absorption.Handler.Invocations.Should().Be(0);

        absorption.Executions.PumpHeldRequests();
        absorption.Session.TryDequeueHeldExecutionResponse(out _, out _).Should().BeFalse("nothing was parked");
    }

    // ---- harness -------------------------------------------------------------

    private const long ActorId = 1001;

    private const long DeadlineMs = 1_700_000_000_000;

    private static Absorption Park(string suffix, bool canMove, bool usingTool)
    {
        var persistence = new FakePersistence();
        var scope = new BridgeScope("stardew", $"save-{suffix}", $"world-{suffix}", ActorId.ToString(), $"companion-{suffix}");
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);
        Farmer actor = CreateActor(canMove, usingTool);
        executions.SetTestActorResolver(() => actor);
        var handler = new AdmittingActionHandler(executions);
        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == "move_to_tile"), handler);

        const string token = "held_absorption_token_0123456789";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, Hello(scope, token), out _, out string authReason).Should().BeTrue(authReason);
        var request = new BridgeEnvelope<BridgeExecutionRequest>(
            BridgeProtocol.Version,
            $"msg_{suffix}",
            $"corr_{suffix}",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "execution_request",
            new BridgeExecutionRequest(
                $"req_{suffix}",
                $"idemp_{suffix}",
                "move_to_tile",
                new BridgeExecutionArgs { X = 5, Y = 6 },
                executions.Revision,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000));
        return new Absorption(executions, session, handler, actor, request);
    }

    /// <summary>
    /// A FormatterServices-created probe farmer: the shared harness pattern for a Game1.player stand-in.
    /// Every field the disposition projection reads is seeded, because the admission reads the whole
    /// per-tick fact set.
    /// </summary>
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

    private static BridgeEnvelope<BridgeHello> Hello(BridgeScope scope, string token) =>
        new(BridgeProtocol.Version, "msg_hello", "corr_hello", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));

    private sealed record Absorption(
        ExecutionManager Executions,
        BridgeSession Session,
        AdmittingActionHandler Handler,
        Farmer Actor,
        BridgeEnvelope<BridgeExecutionRequest> Request)
    {
        /// <summary>The native animation ends: the actor is idle again, and nothing else about the world changed.</summary>
        internal void FreeTheBody()
        {
            Farmer free = CreateActor(canMove: true, usingTool: false);
            this.Executions.SetTestActorResolver(() => free);
        }

        /// <summary>
        /// Seats one in-flight execution on the manager's private slot, the technique <see cref="BodyOwnerNamingTests"/>
        /// already uses: those slots are otherwise only populated by live gameplay.
        /// </summary>
        internal void OwnTheBody(string slot, object specification) =>
            BodySlotSeeding.Seed(this.Executions, slot, specification);

        /// <summary>That execution reaching its terminal receipt: the slot clears and the body is free.</summary>
        internal void ReleaseTheBody(string slot) => BodySlotSeeding.Seed(this.Executions, slot, null);

        internal BridgeEnvelope<BridgeReceipt> TakeAnswer()
        {
            this.Session.TryDequeueHeldExecutionResponse(out _, out string json)
                .Should().BeTrue("the park resolves into an answer");
            BridgeProtocol.TryDeserializeExecutionReceipt(json, out BridgeEnvelope<BridgeReceipt>? envelope, out string reason)
                .Should().BeTrue(reason);
            return envelope!;
        }
    }

    /// <summary>
    /// The one thing every real handler does at the same place: ask the shared admission, and return its
    /// answer instead of doing the native work. The native work here is a counted invocation, because
    /// "exactly once" is the property the absorption must not break.
    /// </summary>
    private sealed class AdmittingActionHandler : IFarmhandActionHandler
    {
        private readonly ExecutionManager executions;

        internal AdmittingActionHandler(ExecutionManager executions) => this.executions = executions;

        internal int Invocations { get; private set; }
        internal string? ExecutionId { get; private set; }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatch
                && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                ? bound
                : Guid.NewGuid().ToString("N");
            // AdmitExecution is deliberately private (ToolApproachContractTests pins that form), so the seam
            // is driven the way this suite already drives it for the Modal profile.
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
            this.ExecutionId = executionId;
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

    private sealed class FakePersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;

        public FarmhandExecutionJournalState? Read(string key) => this.state;

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            this.state = value;
            return true;
        }
    }
}
