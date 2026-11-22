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
/// The bounded wait every park already has, and the one thing it must never produce.
///
/// <para>
/// A parked request is answered twice over while its bridge is attached: the wait dispatches it the moment the body
/// frees, or it ends in the named hold it waited on. NEITHER END IS A RECEIPT. A request that was never dispatched has
/// not started, so it has no execution state to publish - the park's marker is deliberately never stored or published -
/// and the answer its dispatch owes is a refusal on the bridge's own channel. Minting a `rejected` receipt there instead
/// was measured ending two runs (`round66` and `round73`) with
/// `execution_receipt_replay_rejected:terminal_state_rewritten`, because the same request was dispatched afterwards and
/// its real settlement arrived for an executionId the Host had already settled.
/// </para>
///
/// <para>
/// The silence this file closed first is the park whose bridge is gone: the wait's window used to be checked inside the
/// same early return that asked for a resolver, so a park nothing could answer stayed parked forever. It still ends, in
/// the same window every other park ends in - it is drained and reported, and it mints nothing, because there is no
/// execution to state and no session to answer.
/// </para>
/// </summary>
public sealed class HeldParkDeadlineTests
{
    [Fact]
    public void AnAbandonedPark_StillExpires_AndMintsNoReceipt()
    {
        ParkedHold hold = Park("abandoned", canMove: false, usingTool: true);
        hold.Session.TryExecute(1, hold.Request, out BridgeEnvelope<BridgeReceipt>? parked, out string parkedReason)
            .Should().BeTrue(parkedReason);
        parked.Should().BeNull("the Mod holds the request until the body frees");
        parkedReason.Should().Be(ExecutionManager.HeldRequestMarker);
        hold.DropTheResolver();

        Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
        hold.Executions.PumpHeldRequests();

        hold.Executions.TryGetReceipt(hold.Request.Payload.RequestId, out _)
            .Should().BeFalse(
                "a wait that never dispatched has no execution state to publish: a receipt here claims a terminal for an "
                + "execution whose only artifact would be that terminal");
        hold.ParkedCount().Should().Be(0, "the park must drain: a bounded collection with no drain is a leak");
        hold.Handler.Invocations.Should().Be(0, "the window is the whole promise: an abandoned park never dispatches");
        hold.Session.TryDequeueHeldExecutionResponse(out _, out _)
            .Should().BeFalse("no bridge was left to answer, so nothing may be queued for one");
    }

    [Fact]
    public void AnAbandonedParkWhoseBodyFreed_EndsWithoutDispatching()
    {
        ParkedHold hold = Park("abandoned-free", canMove: false, usingTool: true);
        hold.Session.TryExecute(1, hold.Request, out _, out string parkedReason).Should().BeTrue(parkedReason);
        hold.DropTheResolver();
        hold.FreeTheBody();

        Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
        hold.Executions.PumpHeldRequests();

        hold.Handler.Invocations.Should().Be(0, "nothing may dispatch a request whose bridge is gone: the wait ends, it does not proceed");
        hold.Executions.TryGetReceipt(hold.Request.Payload.RequestId, out _)
            .Should().BeFalse("the freed body does not turn a wait into an execution either: nothing ran, so nothing is stated");
        hold.ParkedCount().Should().Be(0);
    }

    [Fact]
    public void AnAbandonedPark_InsideTheWindow_KeepsWaiting()
    {
        ParkedHold hold = Park("abandoned-early", canMove: false, usingTool: true);
        hold.Session.TryExecute(1, hold.Request, out _, out string parkedReason).Should().BeTrue(parkedReason);
        hold.DropTheResolver();

        hold.Executions.PumpHeldRequests();

        hold.Executions.TryGetReceipt(hold.Request.Payload.RequestId, out _)
            .Should().BeFalse("the abandoned park waits the SAME window; losing the bridge is not a shorter deadline");
        hold.ParkedCount().Should().Be(1);
    }

    [Fact]
    public void AWaitThatOutlivesItsWindow_IsAnsweredAsTheHoldItWaitedOn_AndMintsNoReceipt()
    {
        ParkedHold hold = Park("live", canMove: false, usingTool: true);
        hold.Session.TryExecute(1, hold.Request, out _, out string parkedReason).Should().BeTrue(parkedReason);

        Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
        hold.Executions.PumpHeldRequests();

        hold.Executions.TryGetReceipt(hold.Request.Payload.RequestId, out _)
            .Should().BeFalse("a wait is not an outcome, with a bridge to answer it or without one");
        (string holdCode, string _) = ArrivalHold(hold.Actor);
        (string Type, string ReasonCode, string CorrelationId) refusal = hold.TakeRefusal();
        refusal.Type.Should().Be("error", "the request is answered on the bridge's refusal channel, not with a receipt");
        refusal.ReasonCode.Should().Be(
            holdCode,
            "the refusal keeps the admission's own hold code, byte for byte - that is what names what held the request");
        refusal.CorrelationId.Should().Be(hold.Request.CorrelationId, "the answer belongs to the request that waited");
        hold.ParkedCount().Should().Be(0);
    }

    [Fact]
    public void TheExclusiveOwnerTickPath_DeliversTheAnswersItResolves()
    {
        string source = File.ReadAllText(
            Path.GetFullPath(
                Path.Combine(
                    AppContext.BaseDirectory,
                    "../../../../../../../",
                    "integrations",
                    "stardew",
                    "ModEntry.cs")));
        int start = source.IndexOf("private void PumpBridgeWhileBodyOwned(", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, "the polled tick for an exclusive body owner is the thing this invariant is about");
        string body = source[start..source.IndexOf("\n    }", start, StringComparison.Ordinal)];
        body.Should().Contain("state.Executions?.Update();");
        body.Should().Contain(
            "DeliverHeldExecutionResponses(state);",
            "the state machine and the answers it resolves for parked requests travel together on every tick - "
            + "an exclusive-owner tick that pumps the pump but not its delivery mints a receipt the wire never sees");
    }

    // ---- harness -------------------------------------------------------------

    private const long ActorId = 1001;

    private const long DeadlineMs = 1_700_000_000_000;

    /// <summary>The pair the one WorldModel authority produces for the hold this probe actor is under.</summary>
    private static (string HoldCode, string HoldEvidence) ArrivalHold(Farmer actor)
    {
        ActorWorldFacts facts = WorldModel.ReadFacts(actor);
        return WorldModel.DescribeHeldBody(WorldModel.Classify(facts), facts, actor.CanMove, BodyHoldFact.Free);
    }

    private static ParkedHold Park(string suffix, bool canMove, bool usingTool)
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

        const string token = "held_park_deadline_token_0123456789";
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
        return new ParkedHold(executions, session, handler, actor, request);
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

    private sealed record ParkedHold(
        ExecutionManager Executions,
        BridgeSession Session,
        AdmittingActionHandler Handler,
        Farmer Actor,
        BridgeEnvelope<BridgeExecutionRequest> Request)
    {
        /// <summary>
        /// The bridge that parked the request goes away mid-wait: the exact state a replaced session leaves behind,
        /// where the park's window is the only thing that can still end the wait.
        /// </summary>
        internal void DropTheResolver() => AdmissionField("heldRequestResolver").SetValue(this.Admission(), null);

        /// <summary>The native animation ends: the actor is idle again, and nothing else about the world changed.</summary>
        internal void FreeTheBody() =>
            this.Executions.SetTestActorResolver(() => CreateActor(canMove: true, usingTool: false));

        internal int ParkedCount() =>
            ((System.Collections.IDictionary)AdmissionField("heldRequestsByRequestId").GetValue(this.Admission())!).Count;

        /// <summary>The parked requests live in the admission, which is where the wait is pumped from.</summary>
        private ExecutionAdmission Admission() =>
            (ExecutionAdmission)typeof(ExecutionManager)
                .GetField("admission", BindingFlags.NonPublic | BindingFlags.Instance)!
                .GetValue(this.Executions)!;

        private static FieldInfo AdmissionField(string name) =>
            typeof(ExecutionAdmission).GetField(name, BindingFlags.NonPublic | BindingFlags.Instance)
                ?? throw new InvalidOperationException($"ExecutionAdmission.{name} field unavailable.");

        internal BridgeEnvelope<BridgeReceipt> TakeAnswer()
        {
            this.Session.TryDequeueHeldExecutionResponse(out _, out string json)
                .Should().BeTrue("the park resolves into an answer");
            BridgeProtocol.TryDeserializeExecutionReceipt(json, out BridgeEnvelope<BridgeReceipt>? envelope, out string reason)
                .Should().BeTrue(reason);
            return envelope!;
        }

        /// <summary>
        /// The refusal a wait ends in: a frame on the bridge's own error channel, carrying the hold's code and the
        /// correlation of the request it answers. Read as JSON because the envelope's payload is the refusal itself -
        /// there is no receipt to deserialize, and that is the point.
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
    /// The one thing every real handler does at the same place: ask the shared admission, and return its answer
    /// instead of doing the native work. The native work here is a counted invocation.
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
            // AdmitExecution is deliberately private (ToolApproachContractTests pins that form), so the seam
            // is driven the way the suite already drives it for the Modal profile.
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
