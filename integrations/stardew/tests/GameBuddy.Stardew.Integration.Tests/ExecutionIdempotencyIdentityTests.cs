using System;
using System.Reflection;
using System.Runtime.Serialization;
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
/// What the idempotency fingerprint DECIDES, driven through the real bridge session.
///
/// <para>
/// `BridgeSession.TryExecute` remembers each dispatch under its `idempotencyKey` together with a
/// fingerprint of the request. A second request carrying that key is either answered with the
/// stored receipt (same fingerprint: a replay) or refused by name (`idempotency_key_conflict`:
/// two intents under one identity). The fingerprint is therefore the only authority on the
/// question "did the caller send this again, or did it send something else?".
/// </para>
/// <para>
/// The two tests below are the two halves of that question, in the one shape where a collision is
/// reachable: a dispatch that ends in a REFUSAL. A refusal receipt is minted at the current
/// revision and does not advance it (`ExecutionManager.AdmitExecution` / `RejectBodyOwned`), so the
/// next request still satisfies the revision gate and really is looked up in the idempotency cache
/// - which is exactly where a fingerprint narrower than the request hands a caller somebody else's
/// receipt.
/// </para>
/// </summary>
public sealed class ExecutionIdempotencyIdentityTests
{
    /// <summary>
    /// `send_multiplayer_chat` declares exactly one argument and it is `text`. The hand-written
    /// fingerprint did not hash it, so two different chat lines under one identity were
    /// indistinguishable: the second was answered with the first's refusal and never dispatched.
    /// </summary>
    [Fact]
    public void TwoDifferentChatLinesUnderOneIdentity_AreANamedConflict_NotAReplay()
    {
        Harness harness = Harness.Create("chat_identity");

        BridgeEnvelope<BridgeExecutionRequest> first = harness.Request("req_chat_1", "idem_chat_1", "hello farm");
        harness.Session.TryExecute(1, first, out BridgeEnvelope<BridgeReceipt>? firstAnswer, out string firstReason)
            .Should().BeTrue(firstReason);
        firstReason.Should().Be("accepted");
        firstAnswer!.Payload.State.Should().Be("rejected");
        firstAnswer.Payload.ReasonCode.Should().Be("world_not_ready");
        harness.Executions.Revision.Should().Be(
            firstAnswer.Payload.Revision,
            "a refusal is minted at the current revision and does not advance it, which is what keeps the second "
            + "request inside the revision gate");

        // A DIFFERENT chat line, under the same request identity the caller reused - the only thing
        // that separates the two intents is `text`.
        BridgeEnvelope<BridgeExecutionRequest> second = harness.Request("req_chat_1", "idem_chat_1", "goodbye farm");
        bool accepted = harness.Session.TryExecute(1, second, out BridgeEnvelope<BridgeReceipt>? secondAnswer, out string secondReason);

        secondReason.Should().Be(
            "idempotency_key_conflict",
            "the second request is a different message under the first request's identity. Answering it with the first "
            + "request's receipt silently swallows the line the caller actually asked to send, and the caller believes "
            + "the refusal it reads belongs to its own request.");
        accepted.Should().BeFalse("a conflict is a refusal of the second request, not a dispatch of it");
        secondAnswer.Should().BeNull("no receipt is produced for a request that was never dispatched");
    }

    /// <summary>
    /// The other direction, and the one the fix must not break: the SAME request arriving twice is a
    /// replay, answered with the stored receipt and no second dispatch. If the material ever grows a
    /// field the request does not declare - a deadline, a clock, a live game fact - an honest retry
    /// becomes a conflict and the action can never be completed through a resend.
    /// </summary>
    [Fact]
    public void TheSameChatLineUnderOneIdentity_IsAnsweredWithTheStoredReceipt()
    {
        Harness harness = Harness.Create("chat_replay");

        BridgeEnvelope<BridgeExecutionRequest> request = harness.Request("req_replay_1", "idem_replay_1", "hello farm");
        harness.Session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? firstAnswer, out string firstReason)
            .Should().BeTrue(firstReason);
        firstReason.Should().Be("accepted");

        // A fresh envelope for the identical request: the retry the caller is allowed to make.
        BridgeEnvelope<BridgeExecutionRequest> retry = harness.Request("req_replay_1", "idem_replay_1", "hello farm");
        harness.Session.TryExecute(1, retry, out BridgeEnvelope<BridgeReceipt>? replayAnswer, out string replayReason)
            .Should().BeTrue(replayReason);

        replayReason.Should().Be("idempotent_replay");
        replayAnswer!.Payload.Should().BeEquivalentTo(firstAnswer!.Payload, "a replay is the receipt the first dispatch stored, not a second story");
        replayAnswer.CorrelationId.Should().Be(retry.CorrelationId, "the answer belongs to the request that asked");
    }

    // ---- harness -------------------------------------------------------------

    /// <summary>
    /// A real bridge session over the real registry entry for `send_multiplayer_chat`, with the
    /// native chat ingress replaced by the one thing every handler does first: ask the shared
    /// admission. No actor is resolvable, so the admission refuses with `world_not_ready` - the
    /// product's own refusal, minted at the current revision without advancing it.
    /// </summary>
    private sealed record Harness(ExecutionManager Executions, BridgeSession Session, BridgeScope Scope, string Token)
    {
        internal static Harness Create(string suffix)
        {
            var scope = new BridgeScope("stardew", $"save-{suffix}", $"world-{suffix}", "1001", $"companion-{suffix}");
            var publication = FarmhandCapabilityPublication.Initial(
                new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal) { "send_multiplayer_chat" });
            var executions = new ExecutionManager(
                new DummyMonitor(),
                () => publication,
                executionJournal: new FarmhandExecutionJournal(new FakePersistence()),
                executionScope: scope);
            executions.SetTestActorResolver(() => null);

            var router = new FarmhandActionRouter();
            router.Register(
                FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == "send_multiplayer_chat"),
                new AdmittingChatHandler(executions));

            const string token = "chat_identity_token_0123456789a";
            var session = new BridgeSession(executions, router, scope, token, () => publication);
            session.TryAuthenticate(1, Hello(scope, token), out _, out string authReason).Should().BeTrue(authReason);
            return new Harness(executions, session, scope, token);
        }

        internal BridgeEnvelope<BridgeExecutionRequest> Request(string requestId, string idempotencyKey, string text) =>
            new(
                BridgeProtocol.Version,
                $"msg_{requestId}",
                $"corr_{requestId}",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                this.Scope,
                "execution_request",
                new BridgeExecutionRequest(
                    requestId,
                    idempotencyKey,
                    "send_multiplayer_chat",
                    new BridgeExecutionArgs { Text = text },
                    this.Executions.Revision,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000));
    }

    private static BridgeEnvelope<BridgeHello> Hello(BridgeScope scope, string token) =>
        new(BridgeProtocol.Version, "msg_hello", "corr_hello", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));

    /// <summary>The native chat ingress is the boundary this test does not own; the shared admission is not.</summary>
    private sealed class AdmittingChatHandler : IFarmhandActionHandler
    {
        private readonly ExecutionManager executions;

        internal AdmittingChatHandler(ExecutionManager executions) => this.executions = executions;

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatch
                && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                ? bound
                : Guid.NewGuid().ToString("N");
            // AdmitExecution is private by design (ToolApproachContractTests pins that form), so the
            // seam is driven the way this suite already drives it.
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

            LocalExecutionReceipt receipt = new(
                executionId,
                request.RequestId,
                ExecutionState.Accepted,
                "chat_message_sent",
                ledger.CurrentRevision,
                $"text={request.Args.Text}");
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
