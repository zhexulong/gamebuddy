using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
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
/// ONE EXECUTION HAS ONE TERMINAL, ON EACH CHANNEL.
///
/// <para>
/// The Mod reaches a consumer through two channels for the SAME receipt: the fact it pushes when a receipt is minted
/// (<c>ExecutionManager.AddTrace</c> -&gt; <c>ModEntry.PublishReceipt</c> -&gt; <c>BridgeSession.TryCreateReceiptEvent</c>,
/// correlated to the receipt's own requestId), and the answer to the <c>execution_request</c> that asked for it
/// (<c>BridgeSession.TryExecute</c>, correlated to that envelope). The two frames must be byte-identical, because the
/// Host audits a receipt against the fact it saw and refuses a same-revision transition whose content differs.
/// </para>
///
/// <para>
/// What must NOT happen is one execution being published to the fact channel twice. Measured 2026-11-09 in two live
/// slices: one <c>feed_animal</c> execution published <c>succeeded/hay_placed_in_trough</c> twice and one
/// <c>pet_farm_animal</c> execution published <c>rejected/farm_animal_already_petted_today</c> twice, while a
/// <c>collect_animal_product</c> execution published one. The consumer counts terminals per execution, so a second
/// publication is a phantom the cadence and settle accounting both inherit. These pins fix the producing side of that
/// invariant: one pushed terminal fact per execution, whatever path or number of asks produced it. The client-side half
/// (an answer is not a fact) is pinned in <c>host/src/local-stardew-bridge.test.ts</c>.
/// </para>
///
/// <para>
/// Every pin drives the REAL <see cref="BridgeSession"/>, the REAL ledger and the REAL router; the only stub is the
/// native action body, which mints the receipt its family mints.
/// </para>
/// </summary>
public sealed class ExecutionTerminalUniquenessTests
{
    private const long DeadlineMs = 30_000;

    [Fact]
    public void OneDispatchPublishesOneTerminalFact_AndAnswersWithTheSameBytes()
    {
        Harness harness = Harness.Create("plain");

        harness.Dispatch(out BridgeEnvelope<BridgeReceipt>? response, out string reason);
        reason.Should().Be("accepted");
        response.Should().NotBeNull("a synchronous dispatch answers its own request");

        harness.TerminalsOf(Harness.TerminalChannel.Published).Should().HaveCount(1);
        harness.TerminalsOf(Harness.TerminalChannel.Answered).Should().HaveCount(1);
        harness.TerminalsOf(Harness.TerminalChannel.Answered).Should().Equal(
            harness.TerminalsOf(Harness.TerminalChannel.Published),
            "the answer and the fact describe the same transition, byte for byte");
    }

    [Fact]
    public void AReplayedDispatchDoesNotPublishASecondTerminalFact()
    {
        Harness harness = Harness.Create("replay");
        harness.Dispatch(out _, out string firstReason);
        firstReason.Should().Be("accepted");

        // The same request again: the shape a lost answer, a stale-snapshot retry or a deliberate runner probe takes.
        // It is answered from the ledger, and the execution it describes was already published once.
        harness.Dispatch(out BridgeEnvelope<BridgeReceipt>? replay, out string replayReason);
        replayReason.Should().Be("idempotent_replay");
        replay.Should().NotBeNull();

        harness.TerminalsOf(Harness.TerminalChannel.Published).Should().HaveCount(1,
            "a replay is the SAME execution: a second publication is a phantom terminal for every consumer that counts");
        harness.TerminalsOf(Harness.TerminalChannel.Answered).Should().HaveCount(2,
            "each ask is answered once - a replayed request is a second answer, not a second execution");
    }

    [Fact]
    public void AParkedDispatchPublishesOneTerminalFact_AndAnswersItOnce()
    {
        Harness harness = Harness.Create("parked", bodyHeld: true);
        harness.Dispatch(out BridgeEnvelope<BridgeReceipt>? parked, out string parkedReason);
        parkedReason.Should().Be(ExecutionManager.HeldRequestMarker);
        parked.Should().BeNull("a parked request has no answer yet");

        harness.FreeTheBody();
        for (int tick = 0; tick < 3; tick++)
            harness.Executions.PumpHeldRequests();
        harness.DrainDeferred();
        harness.Handler.Invocations.Should().Be(1, "the freed body dispatches the parked request exactly once");

        harness.TerminalsOf(Harness.TerminalChannel.Published).Should().HaveCount(1);
        harness.TerminalsOf(Harness.TerminalChannel.Answered).Should().HaveCount(1,
            "the wait ends in exactly one answer, carrying the receipt the fact channel published");
    }

    [Fact]
    public void AParkedWaitThatExpiresPublishesOneTerminalFact_AndAnswersItOnce()
    {
        Harness harness = Harness.Create("parked-expired", bodyHeld: true);
        harness.Dispatch(out _, out string parkedReason);
        parkedReason.Should().Be(ExecutionManager.HeldRequestMarker);

        Thread.Sleep(WorldModel.TransientRetryWindowMs + 250);
        harness.Executions.PumpHeldRequests();
        harness.DrainDeferred();
        harness.Handler.Invocations.Should().Be(0, "an expired wait never dispatches");

        harness.TerminalsOf(Harness.TerminalChannel.Published).Should().HaveCount(1,
            "the named refusal that ends a wait is published once, like any other terminal");
        harness.TerminalsOf(Harness.TerminalChannel.Answered).Should().HaveCount(1);
    }

    /// <summary>
    /// One bridge session, one ledger, one router, and the two channels a real Mod has for a receipt: the fact funnel
    /// <c>ModEntry.PublishReceipt</c> drives, and whatever answer the request itself is given.
    /// </summary>
    private sealed class Harness
    {
        internal enum TerminalChannel
        {
            Published,
            Answered,
        }

        private readonly List<JsonElement> publishedFrames = new();
        private readonly List<JsonElement> answeredFrames = new();
        private readonly BridgeEnvelope<BridgeExecutionRequest> request;

        private Harness(
            ExecutionManager executions,
            BridgeSession session,
            TerminalActionHandler handler,
            BridgeEnvelope<BridgeExecutionRequest> request)
        {
            this.Executions = executions;
            this.Session = session;
            this.Handler = handler;
            this.request = request;
        }

        internal ExecutionManager Executions { get; }

        internal BridgeSession Session { get; }

        internal TerminalActionHandler Handler { get; }

        internal static Harness Create(string suffix, bool bodyHeld = false)
        {
            var scope = new BridgeScope("stardew", $"save-{suffix}", $"world-{suffix}", "1001", $"companion-{suffix}");
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
            Harness? harness = null;
            var executions = new ExecutionManager(
                new DummyMonitor(),
                () => publication,
                receipt =>
                {
                    // Exactly what ModEntry.PublishReceipt does: serialize the receipt the ledger published.
                    if (harness is not null && harness.Session.TryCreateReceiptEvent(1, receipt, out string json))
                        harness.publishedFrames.Add(Parse(json));
                });
            Farmer actor = CreateActor(bodyHeld);
            executions.SetTestActorResolver(() => actor);
            var handler = new TerminalActionHandler(executions);
            var router = new FarmhandActionRouter();
            router.Register(
                FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == "move_to_tile"),
                handler);

            const string token = "terminal_uniqueness_token_0123456789";
            var session = new BridgeSession(executions, router, scope, token, () => publication);
            session.TryAuthenticate(1, Hello(scope, token), out _, out string authReason)
                .Should().BeTrue(authReason);
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
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + DeadlineMs));
            harness = new Harness(executions, session, handler, request);
            return harness;
        }

        /// <summary>One dispatch: the synchronous answer, or nothing when the admission parked the request.</summary>
        internal void Dispatch(out BridgeEnvelope<BridgeReceipt>? response, out string reason)
        {
            this.Session.TryExecute(1, this.request, out response, out reason).Should().BeTrue(reason);
            if (response is not null && BridgeProtocol.TrySerialize(response, out string answerJson, out _))
                this.answeredFrames.Add(Parse(answerJson));
        }

        internal void FreeTheBody()
        {
            Farmer free = CreateActor(bodyHeld: false);
            this.Executions.SetTestActorResolver(() => free);
        }

        internal void DrainDeferred()
        {
            while (this.Session.TryDequeueHeldExecutionResponse(out _, out string json))
                this.answeredFrames.Add(Parse(json));
        }

        /// <summary>
        /// The terminals one channel carried, as `executionId:reasonCode:state` - the identity a consumer counts, with
        /// the bytes it compares, so two channels can be held to the same transition.
        /// </summary>
        internal IReadOnlyList<string> TerminalsOf(TerminalChannel channel)
        {
            var terminals = new List<string>();
            IEnumerable<JsonElement> frames = channel == TerminalChannel.Published ? this.publishedFrames : this.answeredFrames;
            foreach (JsonElement frame in frames)
            {
                if (frame.GetProperty("type").GetString() != "execution_receipt") continue;
                JsonElement payload = frame.GetProperty("payload");
                string state = payload.GetProperty("state").GetString()!;
                if (state is not ("succeeded" or "rejected" or "failed" or "cancelled" or "invalidated"
                    or "expired" or "uncertain" or "blocked" or "partially_succeeded")) continue;
                terminals.Add(
                    $"{payload.GetProperty("executionId").GetString()}:" +
                    $"{payload.GetProperty("reasonCode").GetString()}:{state}");
            }
            return terminals;
        }

        private static JsonElement Parse(string json)
        {
            using JsonDocument document = JsonDocument.Parse(json);
            return document.RootElement.Clone();
        }

        private static BridgeEnvelope<BridgeHello> Hello(BridgeScope scope, string token) =>
            new(BridgeProtocol.Version, "msg_hello", "corr_hello",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));

        /// <summary>
        /// A probe farmer whose disposition is the one the admission reads: idle and actionable, or held in a tool
        /// swing. Same seeding the other admission pins use.
        /// </summary>
        private static Farmer CreateActor(bool bodyHeld)
        {
            Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            typeof(Farmer)
                .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, new NetLong(1001));
            actor.CanMove = !bodyHeld;
            actor.freezePause = 0;
            typeof(Farmer)
                .GetField("usingTool", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, new NetBool(bodyHeld));
            typeof(Farmer)
                .GetField("netStamina", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, new NetFloat(270f));
            typeof(Farmer)
                .GetField("toolPower", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, new NetInt(0));
            ProbeFarmerSprite.Attach(actor);
            return actor;
        }
    }

    /// <summary>
    /// The one thing every real action body does: admit through the shared gate, then mint its own terminal through
    /// <see cref="IExecutionLedger.RememberTerminal"/> - the same funnel `feed_animal`, `pet_farm_animal` and every
    /// other family uses.
    /// </summary>
    private sealed class TerminalActionHandler : IFarmhandActionHandler
    {
        private readonly ExecutionManager executions;

        internal TerminalActionHandler(ExecutionManager executions) => this.executions = executions;

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
            return ledger.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "terminal_action_succeeded",
                $"tile={request.Args.X},{request.Args.Y}");
        }
    }
}
