using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_durability_failure_names_its_cause:<code>`.
///
/// <para>
/// The durable journal refuses in fourteen different ways - the payload could not be read, the immutable tuple had drifted,
/// the journal was at capacity, the write itself did not land - and every one of them used to reach the Host as the same
/// sentence, <c>execution_receipt_persistence_failed</c>, with the actual code left in a <c>Trace</c> line. So the wire
/// could not say whether the disk refused the write or the journal had never held the row, and a live run could only be
/// explained by reading the log afterwards: measured `round78`, the emote that was refused was answered by the same word as
/// a lost admission.
/// </para>
///
/// <para>
/// THE POPULATION IS THE ENUM, not a list here: every <see cref="FarmhandExecutionJournalResultCode"/> except
/// <see cref="FarmhandExecutionJournalResultCode.Succeeded"/> is driven through the REAL dispatch seam (a
/// <see cref="BridgeSession"/> dispatch that admits the request durably, runs a probe handler, and lets the journal refuse
/// the receipt it mints), and the refusal the Host receives is read from that dispatch. A code the gate cannot drive is
/// reported as undriven rather than passing, and a code whose refusal does not name it is reported as trace-only.
/// </para>
///
/// <para>
/// THE DRIVE-TABLE IS COMPILER-CHECKED, THE POPULATION IS NOT: the switch below names each code it knows how to produce, so
/// a member added to the enum arrives here with no drive, fails this gate by name, and has to be given a way to the wire.
/// </para>
/// </summary>
public sealed class DurabilityFailureCauseNamingGateTests
{
    private const string ProbeReasonCode = "probe_native_ok";
    private const string JournalledAction = "navigate_to_destination";
    private const string ProbeToken = "durability_cause_token_0123456789abcdef";

    private readonly ITestOutputHelper output;

    public DurabilityFailureCauseNamingGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void ADurabilityFailureNamesItsCause()
    {
        List<FarmhandExecutionJournalResultCode> population = Enum
            .GetValues<FarmhandExecutionJournalResultCode>()
            .Where(code => code != FarmhandExecutionJournalResultCode.Succeeded)
            .ToList();
        var reached = new List<FarmhandExecutionJournalResultCode>();
        var traceOnly = new List<FarmhandExecutionJournalResultCode>();
        var undriven = new List<FarmhandExecutionJournalResultCode>();
        foreach (FarmhandExecutionJournalResultCode code in population)
        {
            string? refusal = DriveToRefusal(code);
            if (refusal is null)
            {
                undriven.Add(code);
                this.output.WriteLine($"  {Wire(code)} → no drive");
                continue;
            }

            string expected = ExecutionReceiptStore.DurabilityFailureReason(code);
            bool named = string.Equals(refusal, expected, StringComparison.Ordinal) && BridgeProtocol.IsReasonCode(refusal);
            (named ? reached : traceOnly).Add(code);
            this.output.WriteLine($"  {Wire(code)} → {refusal}");
        }

        string line = $"codes examined {population.Count} · reach-the-wire {reached.Count} · trace-only {traceOnly.Count}";
        this.output.WriteLine(line);
        this.output.WriteLine($"  refused: {string.Join(", ", reached.Select(Wire).OrderBy(name => name, StringComparer.Ordinal))}");

        undriven.Should().BeEmpty(
            because: $"every journal failure code must have a drive that produces it at the wire; undriven: {Names(undriven)} · {line}");
        traceOnly.Should().BeEmpty(
            because: $"a durability refusal must name its cause on the wire, not hide the code in a Trace log; unnamed: {Names(traceOnly)} · {line}");
        reached.Should().BeEquivalentTo(
            population,
            because: $"every journal failure code reaches the Host by name · {line}");
    }

    /// <summary>
    /// Drives one failure code to the refusal the Host receives, or returns null when this gate has no seam that produces
    /// it. Every arm below is a real dispatch: the request is authenticated, admitted durably, routed to a probe handler,
    /// and the handler arranges the one state the journal refuses - so the refusal is observed rather than described.
    /// </summary>
    private static string? DriveToRefusal(FarmhandExecutionJournalResultCode code)
    {
        // The one code the settlement funnel cannot produce: the journal refuses the ADMISSION, before any receipt exists,
        // so the drive composes the manager with the one input that reaches it - a scope the journal's own tuple
        // validation refuses (`SaveId` empty). Everything else about the dispatch is the production path.
        if (code == FarmhandExecutionJournalResultCode.InvalidAdmission)
            return DriveRefusedAdmission();

        string suffix = Wire(code);
        var persistence = new FakeModGlobalDataPersistence();
        BridgeScope scope = CreateScope($"cause-{suffix}");
        FarmhandCapabilityPublication publication = Publication();
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);
        BridgeExecutionRequest request = Request(suffix);
        var router = new FarmhandActionRouter();
        router.Register(
            FarmhandActionCatalog.Registrations.Single(row => row.ActionId == JournalledAction),
            new PoisoningProbeHandler(code, (ledger, executionId) => Poison(code, persistence, scope, request, executionId)));
        var session = new BridgeSession(executions, router, scope, ProbeToken, () => publication);
        session.TryAuthenticate(1, Hello(scope), out _, out string authenticationReason).Should().BeTrue(authenticationReason);
        session.TryExecute(1, Execution(scope, request), out _, out string reasonCode);
        return reasonCode;
    }

    private static string DriveRefusedAdmission()
    {
        var persistence = new FakeModGlobalDataPersistence();
        BridgeScope scope = CreateScope("cause-invalid_admission");
        BridgeScope refusedScope = new("stardew", string.Empty, scope.WorldId, scope.PlayerId, scope.CompanionId);
        FarmhandCapabilityPublication publication = Publication();
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: refusedScope);
        BridgeExecutionRequest request = Request("invalid_admission");
        var router = new FarmhandActionRouter();
        router.Register(
            FarmhandActionCatalog.Registrations.Single(row => row.ActionId == JournalledAction),
            new PoisoningProbeHandler(FarmhandExecutionJournalResultCode.InvalidAdmission, (_, _) => { }));
        var session = new BridgeSession(executions, router, scope, ProbeToken, () => publication);
        session.TryAuthenticate(1, Hello(scope), out _, out string authenticationReason).Should().BeTrue(authenticationReason);
        session.TryExecute(1, Execution(scope, request), out _, out string reasonCode);
        return reasonCode;
    }

    /// <summary>
    /// The state each code is refused for. The seed is what the journal reads AFTER the admission landed, which is exactly
    /// the divergence the code names: a payload that cannot be read, a version from another schema, a duplicated identity,
    /// a row that is no longer the one admitted, or a row that vanished.
    /// </summary>
    private static void Poison(
        FarmhandExecutionJournalResultCode code,
        FakeModGlobalDataPersistence persistence,
        BridgeScope scope,
        BridgeExecutionRequest request,
        string executionId)
    {
        switch (code)
        {
            case FarmhandExecutionJournalResultCode.PersistenceWriteFailed:
                persistence.FailWrites = true;
                return;
            case FarmhandExecutionJournalResultCode.PersistenceReadFailed:
                persistence.FailReads = true;
                return;
            case FarmhandExecutionJournalResultCode.MalformedState:
                persistence.Seed(new FarmhandExecutionJournalState(FarmhandExecutionJournal.SchemaVersion, null));
                return;
            case FarmhandExecutionJournalResultCode.VersionMismatch:
                persistence.Seed(new FarmhandExecutionJournalState(
                    FarmhandExecutionJournal.SchemaVersion + 1,
                    Array.Empty<FarmhandExecutionJournalRecord>()));
                return;
            case FarmhandExecutionJournalResultCode.DuplicateRecord:
                persistence.Seed(new FarmhandExecutionJournalState(
                    FarmhandExecutionJournal.SchemaVersion,
                    new[]
                    {
                        Record(request, scope, executionId),
                        Record(request, scope, executionId, idempotencyKey: "idem_duplicate_copy"),
                    }));
                return;
            case FarmhandExecutionJournalResultCode.CapacityExceeded:
                persistence.Seed(new FarmhandExecutionJournalState(
                    FarmhandExecutionJournal.SchemaVersion,
                    Enumerable.Range(0, FarmhandExecutionJournal.MaximumRecords + 1)
                        .Select(index => Record(
                            request,
                            scope,
                            $"exec_capacity_{index}",
                            requestId: $"req_capacity_{index}",
                            idempotencyKey: $"idem_capacity_{index}"))
                        .ToArray()));
                return;
            case FarmhandExecutionJournalResultCode.NotFound:
                persistence.Seed(new FarmhandExecutionJournalState(
                    FarmhandExecutionJournal.SchemaVersion,
                    Array.Empty<FarmhandExecutionJournalRecord>()));
                return;
            case FarmhandExecutionJournalResultCode.ScopeMismatch:
                persistence.Seed(new FarmhandExecutionJournalState(
                    FarmhandExecutionJournal.SchemaVersion,
                    new[] { Record(request, CreateScope("cause-foreign"), executionId) }));
                return;
            case FarmhandExecutionJournalResultCode.RequestMismatch:
                persistence.Seed(new FarmhandExecutionJournalState(
                    FarmhandExecutionJournal.SchemaVersion,
                    new[] { Record(request, scope, executionId, requestId: "req_other_identity") }));
                return;
            case FarmhandExecutionJournalResultCode.IdempotencyMismatch:
                persistence.Seed(new FarmhandExecutionJournalState(
                    FarmhandExecutionJournal.SchemaVersion,
                    new[] { Record(request, scope, executionId, idempotencyKey: "idem_other_identity") }));
                return;
            case FarmhandExecutionJournalResultCode.ImmutableTupleMismatch:
                persistence.Seed(new FarmhandExecutionJournalState(
                    FarmhandExecutionJournal.SchemaVersion,
                    new[] { Record(request, scope, executionId, deadlineMs: request.DeadlineMs - 1000) }));
                return;
            case FarmhandExecutionJournalResultCode.ReceiptMismatch:
            case FarmhandExecutionJournalResultCode.IllegalStateTransition:
                // Both are produced by the RECEIPT the handler mints, not by the state it finds.
                return;
            default:
                return;
        }
    }

    private static FarmhandExecutionJournalRecord Record(
        BridgeExecutionRequest request,
        BridgeScope scope,
        string executionId,
        string? requestId = null,
        string? idempotencyKey = null,
        long? deadlineMs = null) => new(
        scope,
        requestId ?? request.RequestId,
        idempotencyKey ?? request.IdempotencyKey,
        request.Action,
        FarmhandCanonicalRequest.NavigationDestination(request.Action, "label", "Mine", null),
        request.ExpectedRevision,
        deadlineMs ?? request.DeadlineMs,
        executionId,
        FarmhandExecutionJournalRecordState.AcceptedOrPending,
        null);

    private static BridgeExecutionRequest Request(string suffix)
    {
        return new BridgeExecutionRequest(
            $"req_{suffix}",
            $"idem_{suffix}",
            JournalledAction,
            new BridgeExecutionArgs { Destination = new BridgeNavigationDestinationSelector("label", "Mine", null) },
            ExpectedRevision: 0,
            DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
    }

    private static FarmhandCapabilityPublication Publication() => FarmhandCapabilityPublication.Initial(
        new HashSet<string>(StringComparer.Ordinal) { JournalledAction });

    private static BridgeEnvelope<BridgeHello> Hello(BridgeScope scope) => new(
        BridgeProtocol.Version,
        "msg_hello",
        "corr_hello",
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        scope,
        "hello",
        new BridgeHello(ProbeToken));

    private static BridgeEnvelope<BridgeExecutionRequest> Execution(BridgeScope scope, BridgeExecutionRequest request) => new(
        BridgeProtocol.Version,
        $"msg_{request.RequestId}",
        $"corr_{request.RequestId}",
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        scope,
        "execution_request",
        request);

    private static BridgeScope CreateScope(string suffix) => new(
        "stardew",
        $"save_{suffix}",
        $"world_{suffix}",
        $"player_{suffix}",
        $"companion_{suffix}");

    private static string Wire(FarmhandExecutionJournalResultCode code) =>
        FarmhandExecutionJournalResultCodeNames.WireCode(code);

    private static string Names(IEnumerable<FarmhandExecutionJournalResultCode> codes) =>
        string.Join(", ", codes.Select(Wire));

    /// <summary>
    /// Stands in for the action's native body: it arranges the state the journal refuses, then mints the receipt that
    /// settlement would have minted, so the funnel - not this handler - decides the outcome.
    /// </summary>
    private sealed class PoisoningProbeHandler : IFarmhandActionHandler
    {
        private readonly FarmhandExecutionJournalResultCode code;
        private readonly Action<IExecutionLedger, string> poison;

        internal PoisoningProbeHandler(FarmhandExecutionJournalResultCode code, Action<IExecutionLedger, string> poison)
        {
            this.code = code;
            this.poison = poison;
        }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatch
                && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                ? bound
                : request.RequestId;
            this.poison(ledger, executionId);
            return this.code switch
            {
                // The receipt names an execution the ledger never bound: the journal's identity cross-check is the refusal.
                FarmhandExecutionJournalResultCode.ReceiptMismatch => ledger.RememberTerminal(
                    request.RequestId,
                    "unexpected_receipt_execution",
                    ExecutionState.Succeeded,
                    ProbeReasonCode,
                    "native_dispatched=true"),

                // A settlement for an execution that already settled: the journal's transition check is the refusal.
                FarmhandExecutionJournalResultCode.IllegalStateTransition => this.SettleTwice(request, ledger, executionId),

                _ => ledger.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Succeeded,
                    ProbeReasonCode,
                    "native_dispatched=true"),
            };
        }

        private LocalExecutionReceipt SettleTwice(
            BridgeExecutionRequest request,
            IExecutionLedger ledger,
            string executionId)
        {
            ledger.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                ProbeReasonCode,
                "native_dispatched=true");
            return ledger.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Failed,
                "probe_second_terminal",
                null);
        }
    }

    /// <summary>
    /// The journal's two file operations, with the failures a live run hit: a read that throws, a write that does not land,
    /// and a payload replaced behind the admission.
    /// </summary>
    private sealed class FakeModGlobalDataPersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;

        internal bool FailWrites { get; set; }

        internal bool FailReads { get; set; }

        internal void Seed(FarmhandExecutionJournalState value) => this.state = value;

        public FarmhandExecutionJournalState? Read(string key)
        {
            if (this.FailReads)
                throw new System.IO.IOException("cause-naming probe read failure");
            return this.state;
        }

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            if (this.FailWrites)
                return false;

            this.state = value;
            return true;
        }
    }
}
