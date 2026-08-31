using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class FarmhandExecutionJournalTests
{
    [Fact]
    public void RecordsAdmissionAndFreshJournalPreservesTheExactAdmissionTuple()
    {
        var persistence = new FakeModGlobalDataPersistence();
        FarmhandExecutionAdmission admission = CreateAdmission();

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> recorded =
            new FarmhandExecutionJournal(persistence).TryRecordAdmission(admission);

        recorded.Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        recorded.Record.Should().NotBeNull();

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> loaded =
            new FarmhandExecutionJournal(persistence).TryLoadAdmission(
                admission.Scope,
                admission.RequestId,
                admission.IdempotencyKey);

        loaded.Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        loaded.Record.Should().NotBeNull();
        FarmhandExecutionJournalRecord record = loaded.Record!;
        record.Scope.Should().Be(admission.Scope);
        record.RequestId.Should().Be(admission.RequestId);
        record.IdempotencyKey.Should().Be(admission.IdempotencyKey);
        record.ActionId.Should().Be(admission.ActionId);
        record.Request.Should().BeEquivalentTo(admission.Request);
        record.ExpectedRevision.Should().Be(admission.ExpectedRevision);
        record.DeadlineMs.Should().Be(admission.DeadlineMs);
        record.ExecutionId.Should().Be(admission.ExecutionId);
        record.State.Should().Be(FarmhandExecutionJournalRecordState.AcceptedOrPending);
        record.Receipt.Should().BeNull();
    }

    [Fact]
    public void PersistsTerminalReceiptAndFreshJournalReturnsTheSameActionBoundReceipt()
    {
        var persistence = new FakeModGlobalDataPersistence();
        FarmhandExecutionAdmission admission = CreateAdmission();
        FarmhandExecutionJournal journal = new(persistence);
        FarmhandExecutionReceipt receipt = new(
            admission.ExecutionId,
            admission.RequestId,
            admission.ActionId,
            ExecutionState.Succeeded,
            "navigation_completed",
            admission.ExpectedRevision,
            "arrived=true;postcondition=true");

        journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> transitioned =
            journal.TryPersistReceiptTransition(admission, receipt);

        transitioned.Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        transitioned.Record.Should().NotBeNull();
        transitioned.Record!.Receipt.Should().Be(receipt);

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> loaded =
            new FarmhandExecutionJournal(persistence).TryLookup(
                admission.Scope,
                admission.RequestId,
                admission.IdempotencyKey);

        loaded.Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        loaded.Record.Should().NotBeNull();
        loaded.Record!.State.Should().Be(FarmhandExecutionJournalRecordState.TerminalSettled);
        loaded.Record.Receipt.Should().Be(receipt);
        loaded.Record.Receipt!.ExecutionId.Should().Be(admission.ExecutionId);
        loaded.Record.Receipt.RequestId.Should().Be(admission.RequestId);
        loaded.Record.Receipt.ActionId.Should().Be(admission.ActionId);
    }

    [Fact]
    public void WriteFailureReturnsPersistenceWriteFailedAndLeavesLookupEmpty()
    {
        var persistence = new FakeModGlobalDataPersistence { FailWrites = true };
        FarmhandExecutionAdmission admission = CreateAdmission();
        FarmhandExecutionJournal journal = new(persistence);

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> recorded =
            journal.TryRecordAdmission(admission);

        recorded.Code.Should().Be(FarmhandExecutionJournalResultCode.PersistenceWriteFailed);
        recorded.Record.Should().BeNull();

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> lookup =
            new FarmhandExecutionJournal(persistence).TryLookup(
                admission.Scope,
                admission.RequestId,
                admission.IdempotencyKey);

        lookup.Code.Should().Be(FarmhandExecutionJournalResultCode.NotFound);
        lookup.Record.Should().BeNull();
    }

    [Fact]
    public void CapacityExhaustionRejectsNewAdmissionWithoutEvictingRecoveryEvidence()
    {
        var persistence = new FakeModGlobalDataPersistence();
        FarmhandExecutionAdmission first = CreateAdmission("request-0", "idempotency-0");
        FarmhandExecutionJournalRecord terminal = PendingRecord(first) with
        {
            State = FarmhandExecutionJournalRecordState.TerminalSettled,
            Receipt = CreateReceipt(first),
        };
        FarmhandExecutionJournalRecord[] retained = Enumerable.Range(0, FarmhandExecutionJournal.MaximumRecords)
            .Select(index => index == 0
                ? terminal
                : PendingRecord(CreateAdmission($"request-{index}", $"idempotency-{index}")))
            .ToArray();
        persistence.Seed(new FarmhandExecutionJournalState(FarmhandExecutionJournal.SchemaVersion, retained));
        FarmhandExecutionJournal journal = new(persistence);

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result = journal.TryRecordAdmission(
            CreateAdmission("request-over-capacity", "idempotency-over-capacity"));

        result.Code.Should().Be(FarmhandExecutionJournalResultCode.CapacityExceeded);
        result.Record.Should().BeNull();
        persistence.State!.Records.Should().HaveCount(FarmhandExecutionJournal.MaximumRecords);
        journal.TryLookup(first.Scope, first.RequestId, first.IdempotencyKey).Record!.Receipt
            .Should().Be(CreateReceipt(first));
    }

    [Fact]
    public void OversizedPersistedJournalFailsClosedBeforeQuadraticValidation()
    {
        var persistence = new FakeModGlobalDataPersistence();
        FarmhandExecutionJournalRecord[] oversized = Enumerable.Range(0, FarmhandExecutionJournal.MaximumRecords + 1)
            .Select(index => PendingRecord(CreateAdmission($"request-{index}", $"idempotency-{index}")))
            .ToArray();
        persistence.Seed(new FarmhandExecutionJournalState(FarmhandExecutionJournal.SchemaVersion, oversized));
        FarmhandExecutionAdmission lookup = CreateAdmission("request-0", "idempotency-0");

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result =
            new FarmhandExecutionJournal(persistence).TryLookup(lookup.Scope, lookup.RequestId, lookup.IdempotencyKey);

        result.Code.Should().Be(FarmhandExecutionJournalResultCode.CapacityExceeded);
        result.Record.Should().BeNull();
    }

    [Fact]
    public void VersionMismatchFailsClosedWithNullResult()
    {
        var persistence = new FakeModGlobalDataPersistence();
        FarmhandExecutionAdmission admission = CreateAdmission();
        persistence.Seed(new FarmhandExecutionJournalState(
            FarmhandExecutionJournal.SchemaVersion + 1,
            Array.Empty<FarmhandExecutionJournalRecord>()));

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result =
            new FarmhandExecutionJournal(persistence).TryLookup(
                admission.Scope,
                admission.RequestId,
                admission.IdempotencyKey);

        result.Code.Should().Be(FarmhandExecutionJournalResultCode.VersionMismatch);
        result.Record.Should().BeNull();
    }

    [Fact]
    public void MalformedRecordShapeFailsClosedWithNullResult()
    {
        var persistence = new FakeModGlobalDataPersistence();
        FarmhandExecutionAdmission admission = CreateAdmission();
        FarmhandExecutionJournalRecord malformed = PendingRecord(admission) with { Request = null! };
        persistence.Seed(new FarmhandExecutionJournalState(
            FarmhandExecutionJournal.SchemaVersion,
            new[] { malformed }));

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result =
            new FarmhandExecutionJournal(persistence).TryLookup(
                admission.Scope,
                admission.RequestId,
                admission.IdempotencyKey);

        result.Code.Should().Be(FarmhandExecutionJournalResultCode.MalformedState);
        result.Record.Should().BeNull();
    }

    [Fact]
    public void DuplicateIdentityRecordsFailClosedWithNullResult()
    {
        var persistence = new FakeModGlobalDataPersistence();
        FarmhandExecutionAdmission admission = CreateAdmission();
        FarmhandExecutionJournalRecord first = PendingRecord(admission);
        FarmhandExecutionJournalRecord duplicate = PendingRecord(
            admission with { IdempotencyKey = "idempotency-two" });
        persistence.Seed(new FarmhandExecutionJournalState(
            FarmhandExecutionJournal.SchemaVersion,
            new[] { first, duplicate }));

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result =
            new FarmhandExecutionJournal(persistence).TryLookup(
                admission.Scope,
                admission.RequestId,
                admission.IdempotencyKey);

        result.Code.Should().Be(FarmhandExecutionJournalResultCode.DuplicateRecord);
        result.Record.Should().BeNull();
    }

    [Fact]
    public void WrongScopeAndIdempotencyCannotLookupOrTransitionAnExistingRecord()
    {
        var persistence = new FakeModGlobalDataPersistence();
        FarmhandExecutionAdmission admission = CreateAdmission();
        FarmhandExecutionJournal journal = new(persistence);
        FarmhandExecutionReceipt receipt = CreateReceipt(admission);

        journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        FarmhandExecutionAdmission wrongScope = admission with { Scope = CreateScope("other") };
        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> wrongScopeLookup =
            journal.TryLookup(wrongScope.Scope, wrongScope.RequestId, wrongScope.IdempotencyKey);
        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> wrongScopeTransition =
            journal.TryPersistReceiptTransition(wrongScope, receipt);

        wrongScopeLookup.Code.Should().Be(FarmhandExecutionJournalResultCode.ScopeMismatch);
        wrongScopeLookup.Record.Should().BeNull();
        wrongScopeTransition.Code.Should().Be(FarmhandExecutionJournalResultCode.ScopeMismatch);
        wrongScopeTransition.Record.Should().BeNull();

        FarmhandExecutionAdmission wrongIdempotency = admission with { IdempotencyKey = "idempotency-other" };
        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> wrongIdempotencyLookup =
            journal.TryLookup(
                wrongIdempotency.Scope,
                wrongIdempotency.RequestId,
                wrongIdempotency.IdempotencyKey);
        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> wrongIdempotencyTransition =
            journal.TryPersistReceiptTransition(wrongIdempotency, receipt);

        wrongIdempotencyLookup.Code.Should().Be(FarmhandExecutionJournalResultCode.IdempotencyMismatch);
        wrongIdempotencyLookup.Record.Should().BeNull();
        wrongIdempotencyTransition.Code.Should().Be(FarmhandExecutionJournalResultCode.IdempotencyMismatch);
        wrongIdempotencyTransition.Record.Should().BeNull();

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> original =
            journal.TryLookup(admission.Scope, admission.RequestId, admission.IdempotencyKey);
        original.Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        original.Record.Should().NotBeNull();
        original.Record!.Receipt.Should().BeNull();
    }

    [Fact]
    public void FreshSession_RejectsDurableNavigationReplayWhenTheImmutableDestinationTupleDiffers()
    {
        var persistence = new FakeModGlobalDataPersistence();
        BridgeScope scope = CreateScope("tuple");
        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
        var admission = new FarmhandExecutionAdmission(
            scope,
            "request-tuple",
            "idempotency-tuple",
            "navigate_to_destination",
            FarmhandCanonicalRequest.NavigationDestination("navigate_to_destination", "label", "Mine", null),
            ExpectedRevision: 0,
            DeadlineMs: deadlineMs,
            ExecutionId: "execution-tuple");
        var journal = new FarmhandExecutionJournal(persistence);
        journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        journal.TryPersistReceiptTransition(admission, new FarmhandExecutionReceipt(
            admission.ExecutionId,
            admission.RequestId,
            admission.ActionId,
            ExecutionState.Succeeded,
            "navigation_completed",
            Revision: 1,
            Evidence: "postcondition=true")).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "navigate_to_destination" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);
        var handler = new CountingNavigationHandler();
        var router = new FarmhandActionRouter();
        router.Register(
            FarmhandActionCatalog.Registrations.Single(candidate => candidate.ActionId == "navigate_to_destination"),
            handler);
        const string token = "journal_tuple_token_0123456789abcdef";
        var session = new BridgeSession(executions, router, scope, token, () => publication);
        session.TryAuthenticate(1, new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello-tuple",
            "hello-tuple",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token)), out _, out string authenticationReason).Should().BeTrue(authenticationReason);

        var changedRequest = new BridgeEnvelope<BridgeExecutionRequest>(
            BridgeProtocol.Version,
            "execute-tuple",
            "execute-tuple",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "execution_request",
            new BridgeExecutionRequest(
                admission.RequestId,
                admission.IdempotencyKey,
                admission.ActionId,
                new BridgeExecutionArgs
                {
                    Destination = new BridgeNavigationDestinationSelector("label", "Farm", null),
                },
                admission.ExpectedRevision,
                admission.DeadlineMs));

        session.TryExecute(1, changedRequest, out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode).Should().BeFalse();
        reasonCode.Should().Be("durable_execution_tuple_mismatch");
        response.Should().BeNull();
        handler.ExecutionCount.Should().Be(0);
        executions.TryGetReceipt(admission.RequestId, out _).Should().BeFalse();
    }

    [Fact]
    public void FreshBridgeSession_QueryReturnsTerminalReceiptFromDurableNavigationJournal()
    {
        var persistence = new FakeModGlobalDataPersistence();
        BridgeScope scope = CreateScope("query");
        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
        var admission = new FarmhandExecutionAdmission(
            scope,
            "request-query",
            "idempotency-query",
            "navigate_to_destination",
            FarmhandCanonicalRequest.NavigationDestination("navigate_to_destination", "label", "Mine", null),
            ExpectedRevision: 0,
            DeadlineMs: deadlineMs,
            ExecutionId: "execution-query");
        var journal = new FarmhandExecutionJournal(persistence);
        journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        journal.TryPersistReceiptTransition(admission, new FarmhandExecutionReceipt(
            admission.ExecutionId,
            admission.RequestId,
            admission.ActionId,
            ExecutionState.Succeeded,
            "navigation_completed",
            Revision: 1,
            Evidence: "arrived=true;postcondition=true")).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "navigate_to_destination" });
        var reopenedExecutions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);
        const string token = "journal_query_token_0123456789abcdef";
        var reopenedSession = new BridgeSession(
            reopenedExecutions,
            new FarmhandActionRouter(),
            scope,
            token,
            () => publication);
        reopenedSession.TryAuthenticate(1, new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello-query",
            "hello-query",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token)), out _, out string authenticationReason).Should().BeTrue(authenticationReason);

        var query = new BridgeEnvelope<BridgeExecutionReceiptQuery>(
            BridgeProtocol.Version,
            "query-message",
            "query-correlation",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "execution_receipt_query",
            new BridgeExecutionReceiptQuery(admission.RequestId, admission.IdempotencyKey));

        reopenedSession.TryQueryExecutionReceipt(1, query, out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode).Should().BeTrue(reasonCode);
        reasonCode.Should().Be("accepted");
        response.Should().NotBeNull();
        response!.Type.Should().Be("execution_receipt");
        response.CorrelationId.Should().Be("query-correlation");
        response.Payload.ExecutionId.Should().Be(admission.ExecutionId);
        response.Payload.RequestId.Should().Be(admission.RequestId);
        response.Payload.ActionId.Should().Be(admission.ActionId);
        response.Payload.State.Should().Be("succeeded");
        response.Payload.ReasonCode.Should().Be("navigation_completed");
    }

    [Fact]
    public void TerminalReceiptWriteFailure_QuarantinesReceiptQueryInsteadOfReturningVolatileState()
    {
        var persistence = new FakeModGlobalDataPersistence();
        BridgeScope scope = CreateScope("terminal-write");
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "navigate_to_destination" });
        var publishedReceipts = new List<LocalExecutionReceipt>();
        var manager = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            receiptPublished: publishedReceipts.Add,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);
        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
        var request = new BridgeExecutionRequest(
            "request-terminal-write",
            "idempotency-terminal-write",
            "navigate_to_destination",
            new BridgeExecutionArgs
            {
                Destination = new BridgeNavigationDestinationSelector("label", "Mine", null),
            },
            ExpectedRevision: 0,
            DeadlineMs: deadlineMs);

        manager.TryAdmitNavigation(request, "execution-terminal-write", out string admissionReason)
            .Should().BeTrue(admissionReason);
        persistence.FailWrites = true;
        ((IExecutionLedger)manager).RememberTerminal(
            request.RequestId,
            "execution-terminal-write",
            ExecutionState.Succeeded,
            "navigation_completed",
            "arrived=true;postcondition=true");
        manager.HasDurabilityFailure(request.RequestId).Should().BeTrue();
        publishedReceipts.Should().BeEmpty("an unpersisted terminal result cannot become a public receipt");

        const string token = "journal_terminal_write_token_0123456789abcdef";
        var session = new BridgeSession(manager, new FarmhandActionRouter(), scope, token, () => publication);
        session.TryAuthenticate(1, new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello-terminal-write",
            "hello-terminal-write",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token)), out _, out string authenticationReason).Should().BeTrue(authenticationReason);
        var query = new BridgeEnvelope<BridgeExecutionReceiptQuery>(
            BridgeProtocol.Version,
            "query-terminal-write",
            "query-terminal-write",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "execution_receipt_query",
            new BridgeExecutionReceiptQuery(request.RequestId, request.IdempotencyKey));

        session.TryQueryExecutionReceipt(1, query, out BridgeEnvelope<BridgeReceipt>? response, out string reasonCode)
            .Should().BeFalse();
        reasonCode.Should().Be("execution_receipt_persistence_failed");
        response.Should().BeNull();
    }

    [Fact]
    public void NavigationAdmissionWriteFailure_QuarantinesRetryAndPreservesDispatchIdentity()
    {
        var persistence = new FakeModGlobalDataPersistence { FailWrites = true };
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "navigate_to_destination" });
        var manager = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: CreateScope("quarantine"));
        var request = new BridgeExecutionRequest(
            "request-quarantine",
            "idempotency-quarantine",
            "navigate_to_destination",
            new BridgeExecutionArgs
            {
                Destination = new BridgeNavigationDestinationSelector("label", "Mine", null),
            },
            ExpectedRevision: 42,
            DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000);

        manager.TryAdmitNavigation(request, "execution-first", out string firstReason).Should().BeFalse();
        firstReason.Should().Be(nameof(FarmhandExecutionJournalResultCode.PersistenceWriteFailed));
        manager.HasDurabilityFailure(request.RequestId).Should().BeTrue();

        IDispatchExecutionLedger dispatchLedger = manager;
        dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string firstExecutionId).Should().BeTrue();
        firstExecutionId.Should().Be("execution-first");

        manager.TryAdmitNavigation(request, "execution-retry", out string retryReason).Should().BeFalse();
        retryReason.Should().Be("execution_durability_quarantined");
        dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string preservedExecutionId).Should().BeTrue();
        preservedExecutionId.Should().Be("execution-first");
    }

    private sealed class CountingNavigationHandler : IFarmhandActionHandler
    {
        internal int ExecutionCount { get; private set; }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            this.ExecutionCount++;
            return ledger.RememberTerminal(
                request.RequestId,
                "unexpected-navigation-execution",
                ExecutionState.Succeeded,
                "unexpected_navigation_execution",
                null);
        }
    }

    private static FarmhandExecutionAdmission CreateAdmission(
        string requestId = "request-one",
        string idempotencyKey = "idempotency-one",
        BridgeScope? scope = null)
    {
        const string actionId = "farmhand_action";
        FarmhandCanonicalRequest request = FarmhandCanonicalRequest.SlotItemTargetTile(
            actionId,
            slot: 4,
            x: 12,
            y: 9,
            targetId: "target-one",
            qualifiedItemId: "item-388");

        return new FarmhandExecutionAdmission(
            scope ?? CreateScope("one"),
            requestId,
            idempotencyKey,
            actionId,
            request,
            ExpectedRevision: 42,
            DeadlineMs: 123456789,
            ExecutionId: "execution-one");
    }

    private static FarmhandExecutionReceipt CreateReceipt(FarmhandExecutionAdmission admission) => new(
        admission.ExecutionId,
        admission.RequestId,
        admission.ActionId,
        ExecutionState.Succeeded,
        "completed",
        admission.ExpectedRevision,
        "postcondition=true");

    private static FarmhandExecutionJournalRecord PendingRecord(FarmhandExecutionAdmission admission) => new(
        admission.Scope,
        admission.RequestId,
        admission.IdempotencyKey,
        admission.ActionId,
        admission.Request,
        admission.ExpectedRevision,
        admission.DeadlineMs,
        admission.ExecutionId,
        FarmhandExecutionJournalRecordState.AcceptedOrPending,
        null);

    private static BridgeScope CreateScope(string suffix) => new(
        $"save-{suffix}",
        $"world-{suffix}",
        $"player-{suffix}",
        $"companion-{suffix}",
        $"session-{suffix}");

    private sealed class FakeModGlobalDataPersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;

        internal bool FailWrites { get; set; }

        internal FarmhandExecutionJournalState? State => this.state;

        internal void Seed(FarmhandExecutionJournalState value) => this.state = value;

        public FarmhandExecutionJournalState? Read(string key) => this.state;

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            if (this.FailWrites)
                return false;

            this.state = value;
            return true;
        }
    }
}
