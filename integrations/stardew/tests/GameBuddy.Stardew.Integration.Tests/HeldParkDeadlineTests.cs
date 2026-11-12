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
/// The bounded wait every park already has, and the one state it used to leave open.
///
/// <para>
/// A parked request is answered twice over while its bridge is attached: the wait expires into the admission's
/// own named refusal, and the receipt reaches the Host both as a published fact and as the response the park
/// resolves into. The silence this file closes is the park whose bridge is gone: the wait's window used to be
/// checked inside the same early return that asked for a resolver, so a park nothing could answer stayed parked
/// forever - no receipt, no refusal, and nothing that could ever drain it.
/// </para>
///
/// <para>
/// The deadline is NOT a second window: an abandoned park ends in
/// <see cref="WorldModel.TransientRetryWindowMs"/> like every other park, and the code it mints names both the
/// hold it waited on and the fact that no bridge was left to take the answer.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the deadline pins drive the real admission, park and pump path on a probe actor; the
// delivery pin reads ModEntry's source because the native tick it covers cannot load headless. Both live here
// because they are the two halves of one answer.
public sealed class HeldParkDeadlineTests
{
    [Fact]
    public void AnAbandonedPark_StillExpires_IntoOneNeverAnsweredTerminal()
    {
        ParkedHold hold = Park("abandoned", canMove: false, usingTool: true);
        hold.Session.TryExecute(1, hold.Request, out BridgeEnvelope<BridgeReceipt>? parked, out string parkedReason)
            .Should().BeTrue(parkedReason);
        parked.Should().BeNull("the Mod holds the request until the body frees");
        parkedReason.Should().Be(ExecutionManager.HeldRequestMarker);
        hold.DropTheResolver();

        Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
        hold.Executions.PumpHeldRequests();

        string requestId = hold.Request.Payload.RequestId;
        hold.Executions.TryGetReceipt(requestId, out LocalExecutionReceipt stored)
            .Should().BeTrue("a park nothing can answer must still end in the one terminal receipt its wait owes");
        stored.State.Should().Be(ExecutionState.Rejected);
        // The code names BOTH facts: the hold it waited on (the same code the arrival refusal would have carried)
        // and the fact that no bridge was left to take the answer.
        string holdCode = ArrivalHold(hold.Actor).HoldCode;
        stored.ReasonCode.Should().Be($"{ExecutionManager.HeldRequestNeverAnsweredPrefix}{holdCode}");
        stored.Evidence.Should().Be(ArrivalHold(hold.Actor).HoldEvidence, "the evidence is the hold's own, not a second story");
        stored.ActionId.Should().Be(
            hold.Request.Payload.Action,
            "the receipt carries the action identity the ledger bound when the router accepted the request");
        hold.ParkedCount().Should().Be(0, "the park must drain: a bounded collection with no drain is a leak");

        long settledRevision = stored.Revision;
        hold.Executions.PumpHeldRequests();
        hold.Executions.TryGetReceipt(requestId, out LocalExecutionReceipt again).Should().BeTrue();
        again.Revision.Should().Be(settledRevision, "exactly one terminal is minted for one abandoned wait");
        again.ReasonCode.Should().Be(stored.ReasonCode);
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
        hold.Executions.TryGetReceipt(hold.Request.Payload.RequestId, out LocalExecutionReceipt stored)
            .Should().BeTrue("the freed body does not excuse the wait from its one terminal receipt");
        stored.ReasonCode.Should().Be(
            $"{ExecutionManager.HeldRequestNeverAnsweredPrefix}{ArrivalHold(hold.Actor).HoldCode}",
            "the hold it waited on is the one that arrived with the park, because the live one has ended");
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
    public void AParkWithALiveBridge_KeepsItsByteIdenticalHoldRefusal()
    {
        ParkedHold hold = Park("live", canMove: false, usingTool: true);
        hold.Session.TryExecute(1, hold.Request, out _, out string parkedReason).Should().BeTrue(parkedReason);

        Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
        hold.Executions.PumpHeldRequests();

        hold.Executions.TryGetReceipt(hold.Request.Payload.RequestId, out LocalExecutionReceipt stored)
            .Should().BeTrue();
        stored.State.Should().Be(ExecutionState.Rejected);
        (string holdCode, string holdEvidence) = ArrivalHold(hold.Actor);
        stored.ReasonCode.Should().Be(holdCode, "a park with a bridge to answer it keeps the admission's own code, byte for byte");
        stored.Evidence.Should().Be(holdEvidence);
        stored.ReasonCode.Should().NotStartWith(
            ExecutionManager.HeldRequestNeverAnsweredPrefix,
            "the never-answered code belongs only to the wait no bridge could take");
        hold.TakeAnswer().Payload.State.Should().Be("rejected", "the park resolves into an answer, not only into a ledger fact");
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
        return WorldModel.DescribeCurrentBodyHold(WorldModel.Classify(facts), facts, actor.CanMove);
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
