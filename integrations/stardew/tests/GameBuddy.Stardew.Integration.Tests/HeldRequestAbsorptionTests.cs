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

    /// <summary>
    /// An expired hold answers the SAME named refusal an arrival would have carried - the code the one WorldModel
    /// authority produces - and it answers it on the refusal channel, because nothing was dispatched.
    /// </summary>
    [Fact]
    public void AnExpiredHold_AnswersTheSameNamedRefusalAsOnArrival()
    {
        Absorption absorption = Park("expired", canMove: false, usingTool: true);
        absorption.Session.TryExecute(1, absorption.Request, out _, out string parkedReason).Should().BeTrue(parkedReason);
        parkedReason.Should().Be(ExecutionManager.HeldRequestMarker);

        Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
        absorption.Executions.PumpHeldRequests();

        absorption.Handler.Invocations.Should().Be(0, "an expired hold never dispatches: the window is the whole promise");
        (string type, string reasonCode, string correlationId) = absorption.TakeRefusal();
        type.Should().Be("error", "the wait is answered as a refusal; a receipt would claim an execution that never started");
        correlationId.Should().Be(absorption.Request.CorrelationId);
        // The SAME named refusal as on arrival, in the one vocabulary: the code the WorldModel authority produces for
        // this very hold.
        ActorWorldFacts facts = WorldModel.ReadFacts(absorption.Actor);
        (string holdCode, string _) =
            WorldModel.DescribeHeldBody(WorldModel.Classify(facts), facts, absorption.Actor.CanMove);
        reasonCode.Should().Be("transient_busy");
        reasonCode.Should().Be(holdCode);
        absorption.Executions.TryGetReceipt(absorption.Request.Payload.RequestId, out _)
            .Should().BeFalse("nothing ran, so nothing is stated about an execution");
    }

    /// <summary>
    /// A CUTSCENE IS WAITED OUT, and the wait is bounded by the request's own deadline rather than by the flat
    /// admission's retry window.
    ///
    /// <para>
    /// The measured case (`round56`, day 6 06:00, the furnace cutscene): the event began at 19:55:53, the first request
    /// was refused at 19:55:54.61 with `cutscene_active`, and the world was free again at 19:55:59 - four and a half
    /// seconds after that refusal and two and a half seconds after the retry window this park used to be bounded by.
    /// The park that covered a tool swing could not cover an event, so the request was answered `rejected` on arrival and
    /// the only thing left was a model round-trip whose median is 3.4 s and whose p90 is 25 s (measured 2026-10-19,
    /// `g99cross`) to re-issue the same request into a world that had freed itself.
    /// </para>
    /// <para>
    /// A cutscene is not an action's obstacle: it advances itself or the player advances it, the engine raises
    /// `Game1.eventUp` for exactly as long as it runs, and the request it holds is the same request afterwards. So the
    /// hold is parked like a transient lock and released the moment the world says so - bounded not by a guessed window
    /// but by the deadline the request itself declared, past which its admission can no longer be consumed at all.
    /// </para>
    /// </summary>
    [Fact]
    public void ACutsceneParksTheRequest_PastTheRetryWindow_AndTheFreedWorldDispatchesItExactlyOnce()
    {
        Absorption absorption = Park("cutscene", canMove: false, usingTool: false);
        bool eventUpBefore = Game1.eventUp;
        try
        {
            Game1.eventUp = true;
            absorption.Session.TryExecute(1, absorption.Request, out BridgeEnvelope<BridgeReceipt>? answer, out string reason)
                .Should().BeTrue(reason);
            answer.Should().BeNull("a cutscene that is still running is a wait, not an answer: the request is held");
            reason.Should().Be(ExecutionManager.HeldRequestMarker);
            absorption.Handler.Invocations.Should().Be(0, "nothing may be dispatched into a running event");

            // THE OLD WINDOW, SPENT IN FULL: two seconds of wall clock is longer than the park the tool-swing case uses,
            // and the event is still running, so the wait must still be a wait.
            Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
            absorption.Executions.PumpHeldRequests();
            absorption.Handler.Invocations.Should().Be(0, "the retry window is not the bound for an event");
            absorption.Session.TryDequeueHeldExecutionResponse(out _, out _).Should()
                .BeFalse("a wait that has not ended answers nothing - cutscene_active here would spend the request on a hold that is still in force");
        }
        finally
        {
            Game1.eventUp = eventUpBefore;
        }

        // FALSIFIER for the park: the event ends and the body frees, and the SAME request runs - so the wait above was
        // the admission holding the request, not a request that can no longer run.
        absorption.FreeTheBody();
        absorption.Executions.PumpHeldRequests();

        absorption.Handler.Invocations.Should().Be(1, "the freed world dispatches the waited request exactly once");
        BridgeEnvelope<BridgeReceipt> dispatched = absorption.TakeAnswer();
        dispatched.CorrelationId.Should().Be(absorption.Request.CorrelationId, "the answer belongs to the request that waited");
        dispatched.Payload.State.Should().Be("accepted");
        string detail = dispatched.Payload.Evidence!["detail"];
        var heldMs = System.Text.RegularExpressions.Regex.Match(detail, "(^|;)held_ms=(?<ms>[0-9]+)$");
        heldMs.Success.Should().BeTrue($"the dispatch says how long it waited: {detail}");
        long.Parse(heldMs.Groups["ms"].Value, System.Globalization.CultureInfo.InvariantCulture).Should().BeGreaterThanOrEqualTo(
            WorldModel.TransientRetryWindowMs,
            "the wait covered the whole retry window the event outlived, which is the fact the old park could not state");
        absorption.Session.TryDequeueHeldExecutionResponse(out _, out _).Should().BeFalse("one wait, one answer");
    }

    /// <summary>
    /// THE WAIT IS BOUNDED BY THE REQUEST'S OWN DEADLINE, and when that runs out the request is answered with the hold
    /// it waited on - as a refusal of its dispatch, never as a receipt for an execution that never started.
    ///
    /// <para>
    /// This is the half that keeps the park from becoming a strand: an event that outlives the deadline the caller
    /// declared cannot be waited out any further, because past that instant `Admit` refuses the request as
    /// `invalid_deadline` regardless of the world. The bound is therefore the caller's own declaration, not a number
    /// this Mod picked: the parking window is derived from the request, exactly as the body-program pump derives its
    /// bound from the node's own watchdog.
    /// </para>
    /// </summary>
    [Fact]
    public void ACutsceneThatOutlivesTheRequestsOwnDeadline_EndsInTheNamedRefusal()
    {
        Absorption absorption = Park("cutscene-deadline", canMove: false, usingTool: false, deadlineInMs: 300);
        bool eventUpBefore = Game1.eventUp;
        try
        {
            Game1.eventUp = true;
            absorption.Session.TryExecute(1, absorption.Request, out BridgeEnvelope<BridgeReceipt>? parked, out string reason)
                .Should().BeTrue(reason);
            parked.Should().BeNull("the cutscene is waited out");
            reason.Should().Be(ExecutionManager.HeldRequestMarker);

            Thread.Sleep(500);
            absorption.Executions.PumpHeldRequests();

            absorption.Handler.Invocations.Should().Be(0, "a deadline that ran out is not a licence to dispatch into the hold");
            (string type, string reasonCode, string correlationId) = absorption.TakeRefusal();
            type.Should().Be("error", "the request is answered on the bridge's refusal channel, not with a receipt");
            reasonCode.Should().Be(
                "cutscene_active",
                "the wait ends in the same named hold an arrival would have carried; it is the world's statement, not the Mod's");
            correlationId.Should().Be(
                absorption.Request.CorrelationId,
                "a wait that never dispatched owes an answer to the request it held, and that answer is a refusal");
            absorption.Executions.TryGetReceipt(absorption.Request.Payload.RequestId, out _)
                .Should().BeFalse("a request that never started has no execution state to state");
        }
        finally
        {
            Game1.eventUp = eventUpBefore;
        }
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

    /// <summary>
    /// The wait NAMES what it waited for, and it does so with the one code the admission derives from the owner - 
    /// `waiting_for_body:body_owned_by_activity` - delivered as a refusal rather than as a receipt.
    ///
    /// <para>
    /// The owner's own action id used to ride the refusal receipt's evidence. It does not ride the refusal channel: an
    /// error frame carries a code and nothing else, and a receipt would have to claim an execution state for a request
    /// that never started. The owner CLASS survives in the code, which is what the host's remedy turns into "re-issue the
    /// same request", and that is the trade this line records.
    /// </para>
    /// </summary>
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
        (string type, string reasonCode, _) = absorption.TakeRefusal();
        type.Should().Be("error", "nothing was started, so the answer is a refusal and not a receipt");
        reasonCode.Should().Be("waiting_for_body:body_owned_by_activity");
        absorption.Executions.TryGetReceipt(absorption.Request.Payload.RequestId, out _)
            .Should().BeFalse("the request's identity stays unspent, so whatever it does later is its first outcome");
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

    private static Absorption Park(string suffix, bool canMove, bool usingTool, int deadlineInMs = 30_000)
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
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + deadlineInMs));
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

    /// <summary>The pair the one WorldModel authority produces for the hold this probe actor is under.</summary>
    private static (string HoldCode, string HoldEvidence) ArrivalHold(Farmer actor)
    {
        ActorWorldFacts facts = WorldModel.ReadFacts(actor);
        return WorldModel.DescribeHeldBody(WorldModel.Classify(facts), facts, actor.CanMove);
    }

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

        /// <summary>
        /// The refusal a wait ends in: the bridge's error channel, carrying the hold's code and the correlation of the
        /// request it answers. Read as JSON because the payload IS the refusal - there is no receipt to deserialize.
        /// </summary>
        internal (string Type, string ReasonCode, string CorrelationId) TakeRefusal()
        {
            this.Session.TryDequeueHeldExecutionResponse(out _, out string json)
                .Should().BeTrue("a wait that ended still answers the request it was waiting for");
            using var document = System.Text.Json.JsonDocument.Parse(json);
            System.Text.Json.JsonElement root = document.RootElement;
            return (
                root.GetProperty("type").GetString()!,
                root.GetProperty("payload").GetProperty("reasonCode").GetString()!,
                root.GetProperty("correlationId").GetString()!);
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
