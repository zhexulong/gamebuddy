using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class CandidateActionExecutionTests
{
    [Fact]
    public void Catalog_RegistersExpressEmote_AsExperimentalWithCorrectDescriptor()
    {
        var reg = FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "express_emote");
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Expression);
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Postcondition.Should().Be("emote_finished_or_overridden");
        reg.Descriptor.NativeBinding.Should().Be("Farmer.doEmote");
        reg.Descriptor.Arguments.Should().HaveCount(1);
        reg.Descriptor.Arguments[0].Name.Should().Be("emote");
        reg.Descriptor.Arguments[0].Type.Should().Be("string");
        reg.Descriptor.Arguments[0].Enum.Should().BeEquivalentTo(FarmhandActionCatalog.EmoteEnum);
    }

    [Fact]
    public void Catalog_RegistersFaceDirection_AsExperimentalWithCorrectDescriptor()
    {
        var reg = FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "face_direction");
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Movement);
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Postcondition.Should().Be("actor_facing_matches");
        reg.Descriptor.NativeBinding.Should().Be("Farmer.faceDirection");
        reg.Descriptor.Arguments.Should().HaveCount(1);
        reg.Descriptor.Arguments[0].Name.Should().Be("direction");
        reg.Descriptor.Arguments[0].Type.Should().Be("string");
        reg.Descriptor.Arguments[0].Enum.Should().BeEquivalentTo(FarmhandActionCatalog.DirectionEnum);
    }

    [Fact]
    public void ExpressionActionHandler_ExpressEmote_WhenWorldNotReady_ReturnsRejected()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "express_emote" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new ExpressionActionHandler(executions);

        var request = new BridgeExecutionRequest("req_emote_1", "idemp_emote_1", "express_emote", new BridgeExecutionArgs { Emote = "happy" }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void MovementActionHandler_FaceDirection_WhenWorldNotReady_ReturnsRejected()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "face_direction" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MovementActionHandler(executions);

        var request = new BridgeExecutionRequest("req_face_1", "idemp_face_1", "face_direction", new BridgeExecutionArgs { Direction = "up" }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Router_DispatchesCandidateActionsToRespectiveHandlers()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "express_emote", "face_direction" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "express_emote"), new ExpressionActionHandler(executions));
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "face_direction"), new MovementActionHandler(executions));

        bool emoteRouted = router.TryRoute(
            new BridgeExecutionRequest("req_r_1", "idemp_r_1", "express_emote", new BridgeExecutionArgs { Emote = "sad" }, 1, 5000),
            executions,
            out LocalExecutionReceipt emoteReceipt,
            out string emoteReason);

        emoteRouted.Should().BeTrue();
        emoteReceipt.ReasonCode.Should().Be("world_not_ready");

        bool faceRouted = router.TryRoute(
            new BridgeExecutionRequest("req_r_2", "idemp_r_2", "face_direction", new BridgeExecutionArgs { Direction = "right" }, 1, 5000),
            executions,
            out LocalExecutionReceipt faceReceipt,
            out string faceReason);

        faceRouted.Should().BeTrue();
        faceReceipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Journal_CandidateActions_AdmissionAndReceiptTransitions_PreserveObservation()
    {
        var persistence = new FakeModGlobalDataPersistence();
        var journal = new FarmhandExecutionJournal(persistence);
        var scope = CreateScope("candidate_journal");

        var emoteAdmission = new FarmhandExecutionAdmission(
            scope,
            "req_cand_emote",
            "idemp_cand_emote",
            "express_emote",
            FarmhandCanonicalRequest.EmoteRequest("express_emote", "heart"),
            ExpectedRevision: 5,
            DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30000,
            ExecutionId: "exec_cand_emote");

        journal.TryRecordAdmission(emoteAdmission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        var observation = new BridgeLocalObservation("Farm", 15, 22, 1, "0920", false, 6);
        var emoteReceipt = new FarmhandExecutionReceipt(
            emoteAdmission.ExecutionId,
            emoteAdmission.RequestId,
            emoteAdmission.ActionId,
            ExecutionState.Succeeded,
            "emote_finished_or_overridden",
            Revision: 6,
            Evidence: "emote=heart",
            Observation: observation);

        journal.TryPersistReceiptTransition(emoteAdmission, emoteReceipt).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        var loaded = journal.TryLoadAdmission(scope, emoteAdmission.RequestId, emoteAdmission.IdempotencyKey);
        loaded.Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        loaded.Record.Should().NotBeNull();
        loaded.Record!.Receipt.Should().NotBeNull();
        loaded.Record.Receipt!.Observation.Should().NotBeNull();
        loaded.Record.Receipt!.Observation.Should().BeEquivalentTo(observation);
    }

    [Fact]
    public void BridgeSession_CandidateActions_ValidateExactArgumentShapesAndEnums()
    {
        var scope = CreateScope("shape_test");
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "express_emote", "face_direction" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "express_emote"), new ExpressionActionHandler(executions));
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "face_direction"), new MovementActionHandler(executions));

        const string token = "shape_test_token_0123456789abcdef";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, CreateHelloEnvelope(scope, token), out _, out string authReason).Should().BeTrue(authReason);

        // express_emote with invalid enum
        session.TryExecute(1, CreateExecEnvelope(scope, "req_s1", "idemp_s1", "express_emote", new BridgeExecutionArgs { Emote = "unknown_emote" }), out _, out string reason1).Should().BeFalse();
        reason1.Should().Be("invalid_execution_request");

        // express_emote with extra x/y args
        session.TryExecute(1, CreateExecEnvelope(scope, "req_s2", "idemp_s2", "express_emote", new BridgeExecutionArgs { Emote = "happy", X = 10, Y = 10 }), out _, out string reason2).Should().BeFalse();
        reason2.Should().Be("invalid_execution_request");

        // face_direction with invalid enum
        session.TryExecute(1, CreateExecEnvelope(scope, "req_s3", "idemp_s3", "face_direction", new BridgeExecutionArgs { Direction = "diagonal" }), out _, out string reason3).Should().BeFalse();
        reason3.Should().Be("invalid_execution_request");

        // face_direction with extra slot args
        session.TryExecute(1, CreateExecEnvelope(scope, "req_s4", "idemp_s4", "face_direction", new BridgeExecutionArgs { Direction = "up", Slot = 2 }), out _, out string reason4).Should().BeFalse();
        reason4.Should().Be("invalid_execution_request");
    }

    [Fact]
    public void BridgeSession_ExpressEmote_DurableResponseLossRecovery_RestoresObservation()
    {
        var persistence = new FakeModGlobalDataPersistence();
        var scope = CreateScope("recovery_emote");
        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

        var admission = new FarmhandExecutionAdmission(
            scope,
            "req_loss_emote",
            "idemp_loss_emote",
            "express_emote",
            FarmhandCanonicalRequest.EmoteRequest("express_emote", "happy"),
            ExpectedRevision: 0,
            DeadlineMs: deadlineMs,
            ExecutionId: "exec_loss_emote");

        var journal = new FarmhandExecutionJournal(persistence);
        journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        var observation = new BridgeLocalObservation("Farm", 12, 14, 2, "0800", true, 1);
        journal.TryPersistReceiptTransition(admission, new FarmhandExecutionReceipt(
            admission.ExecutionId,
            admission.RequestId,
            admission.ActionId,
            ExecutionState.Succeeded,
            "emote_finished_or_overridden",
            Revision: 1,
            Evidence: "emote=happy",
            Observation: observation)).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        // Reopened fresh session after crash / response-loss
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "express_emote" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);

        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "express_emote"), new ExpressionActionHandler(executions));

        const string token = "recovery_emote_token_0123456789a";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, CreateHelloEnvelope(scope, token), out _, out string authReason).Should().BeTrue(authReason);

        // 1. Recover via TryQueryExecutionReceipt
        var query = new BridgeEnvelope<BridgeExecutionReceiptQuery>(
            BridgeProtocol.Version,
            "query_loss_msg",
            "query_loss_corr",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "execution_receipt_query",
            new BridgeExecutionReceiptQuery(admission.RequestId, admission.IdempotencyKey));

        session.TryQueryExecutionReceipt(1, query, out BridgeEnvelope<BridgeReceipt>? queryResponse, out string queryReason).Should().BeTrue(queryReason);
        queryResponse.Should().NotBeNull();
        queryResponse!.Payload.Should().NotBeNull();
        queryResponse.Payload.RequestId.Should().Be(admission.RequestId);
        queryResponse.Payload.ExecutionId.Should().Be(admission.ExecutionId);
        queryResponse.Payload.ActionId.Should().Be("express_emote");
        queryResponse.Payload.State.Should().Be("succeeded");
        queryResponse.Payload.ReasonCode.Should().Be("emote_finished_or_overridden");
        queryResponse.Payload.Observation.Should().NotBeNull();
        queryResponse.Payload.Observation.Should().BeEquivalentTo(observation);

        // 2. Recover via TryExecute replay
        var replayRequest = CreateExecEnvelope(scope, admission.RequestId, admission.IdempotencyKey, "express_emote", new BridgeExecutionArgs { Emote = "happy" }, deadlineMs, 0);
        session.TryExecute(1, replayRequest, out BridgeEnvelope<BridgeReceipt>? replayResponse, out string replayReason).Should().BeTrue(replayReason);
        replayReason.Should().Be("durable_replay");
        replayResponse.Should().NotBeNull();
        replayResponse!.Payload.Observation.Should().NotBeNull();
        replayResponse.Payload.Observation.Should().BeEquivalentTo(observation);
    }

    [Fact]
    public void BridgeSession_FaceDirection_DurableResponseLossRecovery_RestoresObservation()
    {
        var persistence = new FakeModGlobalDataPersistence();
        var scope = CreateScope("recovery_face");
        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

        var admission = new FarmhandExecutionAdmission(
            scope,
            "req_loss_face",
            "idemp_loss_face",
            "face_direction",
            FarmhandCanonicalRequest.DirectionRequest("face_direction", "down"),
            ExpectedRevision: 0,
            DeadlineMs: deadlineMs,
            ExecutionId: "exec_loss_face");

        var journal = new FarmhandExecutionJournal(persistence);
        journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        var observation = new BridgeLocalObservation("FarmHouse", 5, 8, 2, "0610", false, 1);
        journal.TryPersistReceiptTransition(admission, new FarmhandExecutionReceipt(
            admission.ExecutionId,
            admission.RequestId,
            admission.ActionId,
            ExecutionState.Succeeded,
            "actor_facing_matches",
            Revision: 1,
            Evidence: "direction=down",
            Observation: observation)).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        // Reopened session
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "face_direction" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);

        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(r => r.ActionId == "face_direction"), new MovementActionHandler(executions));

        const string token = "recovery_face_token_0123456789ab";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, CreateHelloEnvelope(scope, token), out _, out string authReason).Should().BeTrue(authReason);

        // Query receipt
        var query = new BridgeEnvelope<BridgeExecutionReceiptQuery>(
            BridgeProtocol.Version,
            "query_face_msg",
            "query_face_corr",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "execution_receipt_query",
            new BridgeExecutionReceiptQuery(admission.RequestId, admission.IdempotencyKey));

        session.TryQueryExecutionReceipt(1, query, out BridgeEnvelope<BridgeReceipt>? queryResponse, out string queryReason).Should().BeTrue(queryReason);
        queryResponse.Should().NotBeNull();
        queryResponse!.Payload.Observation.Should().NotBeNull();
        queryResponse.Payload.Observation!.Facing.Should().Be(2);
        queryResponse.Payload.ReasonCode.Should().Be("actor_facing_matches");

        // Replay execution
        var replay = CreateExecEnvelope(scope, admission.RequestId, admission.IdempotencyKey, "face_direction", new BridgeExecutionArgs { Direction = "down" }, deadlineMs, 0);
        session.TryExecute(1, replay, out BridgeEnvelope<BridgeReceipt>? replayResponse, out string replayReason).Should().BeTrue(replayReason);
        replayReason.Should().Be("durable_replay");
        replayResponse!.Payload.Observation.Should().NotBeNull();
        replayResponse.Payload.Observation!.Facing.Should().Be(2);
    }

    private static BridgeScope CreateScope(string suffix) => new(
        $"save-{suffix}",
        $"world-{suffix}",
        $"player-{suffix}",
        $"companion-{suffix}",
        $"session-{suffix}");

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
