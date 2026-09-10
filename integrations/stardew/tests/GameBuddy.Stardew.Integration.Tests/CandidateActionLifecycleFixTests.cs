using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Netcode;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Regression coverage for the candidate-action lifecycle defects:
/// (1) handler routability is proven before a durable admission is recorded,
/// (2) native dispatch exceptions become durable terminal Uncertain receipts
/// with the existing admission execution id, and (3) express_emote fails closed
/// because the descriptor postcondition cannot be proven at dispatch time.
/// A candidate dispatch advances the ledger revision, so the exact-tuple replay
/// is exercised through a reopened session over the same durable journal, which
/// is the replay model the Host relies on after a response loss or restart.
/// </summary>
public sealed class CandidateActionLifecycleFixTests
{
    [Fact]
    public void BridgeSession_ExpressEmote_HandlerUnavailable_NeverRecordsDurableAdmission()
    {
        var persistence = new FakeModGlobalDataPersistence();
        var scope = CreateScope("handler_mismatch");
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "express_emote" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);
        // The publication advertises express_emote, but no Expression handler
        // is registered on the dispatch table.
        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "face_direction"), new MovementActionHandler(executions));

        const string token = "handler_mismatch_token_012345678";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, CreateHelloEnvelope(scope, token), out _, out string authReason).Should().BeTrue(authReason);

        var request = CreateExecEnvelope(scope, "req_mismatch_1", "idemp_mismatch_1", "express_emote", new BridgeExecutionArgs { Emote = "happy" });
        session.TryExecute(1, request, out _, out string reason).Should().BeFalse();
        reason.Should().Be("action_not_available");

        // No durable admission and no in-memory receipt may exist for the rejected tuple.
        executions.TryGetDurableAdmission(request.Payload.RequestId, request.Payload.IdempotencyKey, out _, out string durableReason).Should().BeFalse();
        durableReason.Should().Be("receipt_not_found");
        executions.TryGetReceipt(request.Payload.RequestId, out _).Should().BeFalse();

        // Registering the previously missing handler lets the exact same request
        // tuple complete deterministically: the mismatch must never quarantine
        // it behind a pending admission.
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "express_emote"), new ExpressionActionHandler(executions));
        session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? retryResponse, out string retryReason).Should().BeTrue(retryReason);
        retryResponse.Should().NotBeNull();
        retryResponse!.Payload.State.Should().Be("rejected");
        retryResponse.Payload.ReasonCode.Should().Be("world_not_ready");
        executions.TryGetDurableAdmission(request.Payload.RequestId, request.Payload.IdempotencyKey, out FarmhandExecutionJournalRecord? record, out _).Should().BeTrue();
        record!.Receipt.Should().NotBeNull();
    }

    [Fact]
    public void BridgeSession_FaceDirection_NativeException_ReturnsDurableTerminalUncertain()
    {
        var persistence = new FakeModGlobalDataPersistence();
        var scope = CreateActorScope("face_native_exception");
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "face_direction" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);

        var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(ThrowingFaceFarmer));
        WireFarmerIdentity(actor, 1001);
        executions.SetTestActorResolver(() => actor);

        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "face_direction"), new MovementActionHandler(executions));

        const string token = "face_native_exception_token_0";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, CreateHelloEnvelope(scope, token), out _, out string authReason).Should().BeTrue(authReason);

        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
        var request = CreateExecEnvelope(scope, "req_face_ex", "idemp_face_ex", "face_direction", new BridgeExecutionArgs { Direction = "up" }, deadlineMs);
        session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? response, out string reason).Should().BeTrue(reason);
        response!.Payload.State.Should().Be("uncertain");
        response.Payload.ReasonCode.Should().Be("face_direction_native_exception");
        response.Payload.ExecutionId.Should().NotBeNullOrEmpty();

        // The terminal is durable and keyed to the execution minted at admission;
        // the in-memory receipt agrees with the wire response.
        executions.TryGetReceipt(request.Payload.RequestId, out LocalExecutionReceipt localReceipt).Should().BeTrue();
        localReceipt.ExecutionId.Should().Be(response.Payload.ExecutionId);
        localReceipt.State.Should().Be(ExecutionState.Uncertain);
        localReceipt.ReasonCode.Should().Be("face_direction_native_exception");

        // A reopened session over the same journal replays the exact tuple as a
        // durable Uncertain terminal with the same admission execution id; it is
        // never a pending recovery and never a second native execution.
        var reopened = ReopenSession(persistence, scope, "face_direction", "reopen_face_token_0123456789a");
        reopened.Session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? replay, out string replayReason).Should().BeTrue(replayReason);
        replayReason.Should().Be("durable_replay");
        replay!.Payload.State.Should().Be("uncertain");
        replay.Payload.ReasonCode.Should().Be("face_direction_native_exception");
        replay.Payload.ExecutionId.Should().Be(response.Payload.ExecutionId);

        // The durable record is a single terminal record, never duplicated.
        reopened.Executions.TryGetDurableAdmission(request.Payload.RequestId, request.Payload.IdempotencyKey, out FarmhandExecutionJournalRecord? record, out _).Should().BeTrue();
        record!.Receipt.Should().NotBeNull();
        record.Receipt!.State.Should().Be(ExecutionState.Uncertain);
        record.Receipt.ReasonCode.Should().Be("face_direction_native_exception");
    }

    [Fact]
    public void BridgeSession_HandlerExceptionAfterDurableAdmission_ReturnsDurableTerminalUncertain()
    {
        var persistence = new FakeModGlobalDataPersistence();
        var scope = CreateActorScope("handler_exception");
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "face_direction" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);

        var router = new FarmhandActionRouter();
        router.Register(
            FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "face_direction"),
            new ThrowingActionHandler());

        const string token = "handler_exception_token_0123456";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, CreateHelloEnvelope(scope, token), out _, out string authReason).Should().BeTrue(authReason);

        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
        var request = CreateExecEnvelope(
            scope,
            "req_handler_exception",
            "idemp_handler_exception",
            "face_direction",
            new BridgeExecutionArgs { Direction = "up" },
            deadlineMs);

        session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? response, out string reason).Should().BeTrue(reason);
        response.Should().NotBeNull();
        response!.Payload.State.Should().Be("uncertain");
        response.Payload.ReasonCode.Should().Be("handler_exception");
        response.Payload.ExecutionId.Should().NotBeNullOrEmpty();

        executions.TryGetReceipt(request.Payload.RequestId, out LocalExecutionReceipt localReceipt).Should().BeTrue();
        localReceipt.State.Should().Be(ExecutionState.Uncertain);
        localReceipt.ReasonCode.Should().Be("handler_exception");
        localReceipt.ExecutionId.Should().Be(response.Payload.ExecutionId);

        // The exception happened after candidate admission. A reopened session
        // must therefore replay one durable terminal, not expose a pending tuple
        // or invoke the handler a second time.
        var reopened = ReopenSession(persistence, scope, "face_direction", "reopen_handler_exception_token");
        reopened.Session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? replay, out string replayReason).Should().BeTrue(replayReason);
        replayReason.Should().Be("durable_replay");
        replay!.Payload.State.Should().Be("uncertain");
        replay.Payload.ReasonCode.Should().Be("handler_exception");
        replay.Payload.ExecutionId.Should().Be(response.Payload.ExecutionId);

        reopened.Executions.TryGetDurableAdmission(request.Payload.RequestId, request.Payload.IdempotencyKey, out FarmhandExecutionJournalRecord? record, out _).Should().BeTrue();
        record!.Receipt.Should().NotBeNull();
        record.Receipt!.State.Should().Be(ExecutionState.Uncertain);
        record.Receipt.ReasonCode.Should().Be("handler_exception");
    }

    [Fact]
    public void BridgeSession_ExpressEmote_CompletionUnproven_ReturnsDurableTerminalUncertain()
    {
        var persistence = new FakeModGlobalDataPersistence();
        var scope = CreateActorScope("emote_unproven");
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "express_emote" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);

        var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        WireFarmerIdentity(actor, 1001);
        executions.SetTestActorResolver(() => actor);

        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "express_emote"), new ExpressionActionHandler(executions));

        const string token = "emote_unproven_token_0123456";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, CreateHelloEnvelope(scope, token), out _, out string authReason).Should().BeTrue(authReason);

        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
        var request = CreateExecEnvelope(scope, "req_emote_unproven", "idemp_emote_unproven", "express_emote", new BridgeExecutionArgs { Emote = "happy" }, deadlineMs);
        session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? response, out string reason).Should().BeTrue(reason);
        response.Should().NotBeNull();
        // The native dispatch path may or may not have reached the non-virtual
        // Farmer.doEmote; either way the action must fail closed as Uncertain and
        // must never claim a Succeeded that was not proven through the descriptor
        // postcondition (emote_finished_or_overridden).
        response!.Payload.State.Should().Be("uncertain");
        response.Payload.State.Should().NotBe("succeeded");
        response.Payload.ReasonCode.Should().BeOneOf("emote_native_exception", "emote_postcondition_unavailable");
        response.Payload.ExecutionId.Should().NotBeNullOrEmpty();

        // A reopened session over the same journal replays the exact tuple as the
        // same durable Uncertain terminal with the same admission execution id.
        var reopened = ReopenSession(persistence, scope, "express_emote", "reopen_emote_token_012345678");
        reopened.Session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? replay, out string replayReason).Should().BeTrue(replayReason);
        replayReason.Should().Be("durable_replay");
        replay!.Payload.State.Should().Be(response.Payload.State);
        replay.Payload.ReasonCode.Should().Be(response.Payload.ReasonCode);
        replay.Payload.ExecutionId.Should().Be(response.Payload.ExecutionId);
    }

    [Fact]
    public void BridgeSession_ExpressEmote_JarEmote_RejectsBeforeNativeDispatch()
    {
        var persistence = new FakeModGlobalDataPersistence();
        var scope = CreateActorScope("emote_jar");
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "express_emote" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);

        var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        WireFarmerIdentity(actor, 1001);
        executions.SetTestActorResolver(() => actor);

        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "express_emote"), new ExpressionActionHandler(executions));

        const string token = "emote_jar_token_012345678901";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, CreateHelloEnvelope(scope, token), out _, out string authReason).Should().BeTrue(authReason);

        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
        var request = CreateExecEnvelope(scope, "req_emote_jar", "idemp_emote_jar", "express_emote", new BridgeExecutionArgs { Emote = "jar" }, deadlineMs);
        session.TryExecute(1, request, out BridgeEnvelope<BridgeReceipt>? response, out string reason).Should().BeTrue(reason);
        response.Should().NotBeNull();
        // "jar" no longer exists in the Mod dispatch map, so the request rejects
        // with invalid_emote before any native doEmote call: the -1 emote index
        // can never be exposed to the game assembly.
        response!.Payload.State.Should().Be("rejected");
        response.Payload.ReasonCode.Should().Be("invalid_emote");
        response.Payload.ExecutionId.Should().NotBeNullOrEmpty();

        // The rejection is the durable terminal for the admitted tuple.
        executions.TryGetDurableAdmission(request.Payload.RequestId, request.Payload.IdempotencyKey, out FarmhandExecutionJournalRecord? record, out _).Should().BeTrue();
        record!.Receipt.Should().NotBeNull();
        record.Receipt!.State.Should().Be(ExecutionState.Rejected);
        record.Receipt.ReasonCode.Should().Be("invalid_emote");
    }

    private static void WireFarmerIdentity(Farmer farmer, long uniqueMultiplayerId)
    {
        FieldInfo? uidField = typeof(Farmer).GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        if (uidField is null)
            throw new InvalidOperationException("Farmer.uniqueMultiplayerID field unavailable.");
        uidField.SetValue(farmer, new NetLong(uniqueMultiplayerId));
    }

    private sealed class ThrowingFaceFarmer : Farmer
    {
        public override bool isMoving() => false;

        public override void faceDirection(int direction)
            => throw new InvalidOperationException("native face unavailable");
    }

    private sealed class ThrowingActionHandler : IFarmhandActionHandler
    {
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
            => throw new InvalidOperationException("handler failed after admission");
    }

    /// <summary>Reopens a fresh session over the same durable journal for the exact-tuple replay model.</summary>
    private static (ExecutionManager Executions, BridgeSession Session) ReopenSession(
        FakeModGlobalDataPersistence persistence,
        BridgeScope scope,
        string actionId,
        string token)
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { actionId });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);
        var router = new FarmhandActionRouter();
        if (actionId == "express_emote")
            router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == actionId), new ExpressionActionHandler(executions));
        else
            router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == actionId), new MovementActionHandler(executions));
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, CreateHelloEnvelope(scope, token), out _, out string authReason).Should().BeTrue(authReason);
        return (executions, session);
    }

    private static BridgeScope CreateScope(string suffix) => new(
        "stardew",
        $"save-{suffix}",
        $"world-{suffix}",
        $"player-{suffix}",
        $"companion-{suffix}");

    /// <summary>Scope whose PlayerId matches the numeric identity of the fake actor.</summary>
    private static BridgeScope CreateActorScope(string suffix) => new(
        "stardew",
        $"save-{suffix}",
        $"world-{suffix}",
        "1001",
        $"companion-{suffix}");

    private static BridgeEnvelope<BridgeHello> CreateHelloEnvelope(BridgeScope scope, string token) =>
        new(BridgeProtocol.Version, "msg_hello", "corr_hello", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));

    private static BridgeEnvelope<BridgeExecutionRequest> CreateExecEnvelope(
        BridgeScope scope,
        string requestId,
        string idempotencyKey,
        string action,
        BridgeExecutionArgs args,
        long? deadlineMs = null,
        long expectedRevision = 0) =>
        new(BridgeProtocol.Version, $"msg_{requestId}", $"corr_{requestId}", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "execution_request",
            new BridgeExecutionRequest(requestId, idempotencyKey, action, args, expectedRevision, deadlineMs ?? (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000)));

    private sealed class FakeModGlobalDataPersistence : IModGlobalDataPersistence
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