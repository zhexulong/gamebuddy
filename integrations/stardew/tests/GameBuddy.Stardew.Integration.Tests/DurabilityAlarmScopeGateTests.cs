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
/// `a_durability_alarm_covers_only_actions_that_can_change_the_world`.
///
/// The durable journal exists so a response-loss retry cannot become a SECOND native execution of something that
/// already happened, and a terminal receipt it could not record is a real loss for an action that changed the world:
/// the execution coordinator refuses rather than report a change it cannot recover. For an action that changed nothing
/// the same failure means one missing row, and refusing takes away the only thing the action did.
///
/// Measured `round78`, game time 12:10, the instant a warp into `Mine` landed: a pure `express_emote` was answered
/// `execution_receipt_persistence_failed`, `MarkDurabilityFailure` circuit-broke the run, and an emote that touched no
/// world state was counted as a failure.
///
/// THE POPULATION IS THE CATALOGUE, not a list here: every `FarmhandActionCatalog.Registrations` row is crossed with the
/// declaration that decides the alarm (`FarmhandActionCatalog.ChangesTheWorld`) and driven through the REAL receipt
/// funnel with the journal's write failing, so `refused-on-persistence` is observed rather than described.
/// </summary>
public sealed class DurabilityAlarmScopeGateTests
{
    private const string ProbeReasonCode = "probe_native_ok";

    private readonly ITestOutputHelper output;

    public DurabilityAlarmScopeGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void ADurabilityAlarmCoversOnlyActionsThatCanChangeTheWorld()
    {
        IReadOnlyList<FarmhandActionRegistration> population = FarmhandActionCatalog.Registrations;
        List<string> mutating = population.Where(row => FarmhandActionCatalog.ChangesTheWorld(row.ActionId)).Select(row => row.ActionId).ToList();
        List<string> expression = population.Where(row => !FarmhandActionCatalog.ChangesTheWorld(row.ActionId)).Select(row => row.ActionId).ToList();
        var journalled = new List<string>();
        var refused = new List<string>();
        foreach (FarmhandActionRegistration row in population)
        {
            (bool Journalled, bool Refused) probe = ProbeDurability(row.ActionId);
            if (probe.Journalled)
                journalled.Add(row.ActionId);
            if (probe.Refused)
                refused.Add(row.ActionId);
        }

        string line = $"actions examined {population.Count} · mutating {mutating.Count} · expression {expression.Count} · refused-on-persistence {refused.Count}";
        this.output.WriteLine(line);
        this.output.WriteLine($"  journalled: {string.Join(", ", journalled.OrderBy(id => id, StringComparer.Ordinal))}");
        this.output.WriteLine($"  refused:    {string.Join(", ", refused.OrderBy(id => id, StringComparer.Ordinal))}");
        this.output.WriteLine($"  exempt:     {string.Join(", ", expression.OrderBy(id => id, StringComparer.Ordinal))}");

        mutating.Should().NotBeEmpty("every catalogued action is classified by one declaration");
        (mutating.Count + expression.Count).Should().Be(population.Count, because: $"every catalogued action is either mutating or expression · {line}");

        // THE DRIFT GATE. The exemption table and the catalogue's own Expression group are two spellings of one fact, so
        // they must agree in BOTH directions: a new expression action has to be decided here (and its native reason
        // stated), and an action that writes the world cannot be smuggled into the exemption.
        HashSet<string> exempt = new(FarmhandActionCatalog.ActionsThatChangeNothing.Keys, StringComparer.Ordinal);
        HashSet<string> declaredExpression = population
            .Where(row => row.HandlerGroup == FarmhandActionHandlerGroup.Expression)
            .Select(row => row.ActionId)
            .ToHashSet(StringComparer.Ordinal);
        exempt.Should().BeEquivalentTo(
            declaredExpression,
            because: $"the exemption must be exactly the catalogue's Expression group · {line}");
        exempt.Should().BeSubsetOf(population.Select(row => row.ActionId), "an exemption names a catalogued action, never an id nobody serves");
        FarmhandActionCatalog.ActionsThatChangeNothing.Should().OnlyContain(entry => entry.Value.Length > 60, "each exemption states the native reason it cannot change the world");

        // THE GATE. An expression action the funnel refuses is the defect this test exists for, and it is named.
        List<string> refusedExpression = refused.Intersect(expression, StringComparer.Ordinal).ToList();
        refusedExpression.Should().BeEmpty(
            because: $"an expression action loses nothing by an unjournalled receipt, so a durability failure must never refuse it (offenders: {string.Join(", ", refusedExpression)}) · {line}");

        // AND THE ALARM IS STILL ARMED WHERE IT MATTERS: every journalled action that changes the world is refused.
        List<string> journalledMutating = journalled.Where(FarmhandActionCatalog.ChangesTheWorld).ToList();
        journalledMutating.Should().NotBeEmpty(
            because: $"the probe must observe a real alarm, not an empty population · {line}");
        refused.Should().BeEquivalentTo(
            journalledMutating,
            because: $"a receipt the journal could not record refuses exactly the actions that changed the world · {line}");
    }

    /// <summary>
    /// The falsifier: the SAME write fails for an expression action and for one that changes the world, and only the
    /// second is refused.
    ///
    /// The expression arm goes through the bridge exactly as `round78` did - `TryExecute` admits the request, the
    /// handler performs the native effect, and the receipt the funnel cannot journal still reaches the caller. The
    /// world-changing arm is `cut_weeds`, driven through the ingress that WILL journal an arbitrary action id
    /// (`TryAdmitNavigation` records the exact tuple for whatever action it is handed; `cut_weeds`' own receipts are not
    /// durably admitted by the bridge today, so without this the same write could not be made to fail for it at all).
    /// </summary>
    [Fact]
    public void TheSameWriteFailureLetsAnExpressionActionThroughAndStillRefusesAWorldChangingAction()
    {
        // ---- ARM ONE: `express_emote`, end to end through the bridge's own execution entry.
        var emotePersistence = new FakeModGlobalDataPersistence { WritesBeforeFailure = 1 };
        BridgeScope emoteScope = CreateScope("durability-emote");
        FarmhandCapabilityPublication emotePublication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "express_emote" });
        var emoteReceipts = new List<LocalExecutionReceipt>();
        var emoteExecutions = new ExecutionManager(
            new DummyMonitor(),
            () => emotePublication,
            receiptPublished: emoteReceipts.Add,
            executionJournal: new FarmhandExecutionJournal(emotePersistence),
            executionScope: emoteScope);
        var emoteRouter = new FarmhandActionRouter();
        emoteRouter.Register(
            FarmhandActionCatalog.Registrations.Single(row => row.ActionId == "express_emote"),
            new SucceededProbeHandler());
        const string emoteToken = "durability_emote_token_0123456789";
        var emoteSession = new BridgeSession(emoteExecutions, emoteRouter, emoteScope, emoteToken, () => emotePublication);
        emoteSession.TryAuthenticate(1, CreateHelloEnvelope(emoteScope, emoteToken), out _, out string emoteAuthReason).Should().BeTrue(emoteAuthReason);

        emoteSession.TryExecute(
            1,
            CreateExecEnvelope(emoteScope, "req_emote_write_loss", "idem_emote_write_loss", "express_emote", new BridgeExecutionArgs { Emote = "note" }),
            out BridgeEnvelope<BridgeReceipt>? emoteResponse,
            out string emoteReason).Should().BeTrue(emoteReason);
        emoteReason.Should().Be("accepted", "an emote she actually performed is answered, not refused over a row that records no world change");
        emoteResponse.Should().NotBeNull();
        emoteResponse!.Payload.State.Should().Be("succeeded");
        emoteResponse.Payload.ReasonCode.Should().Be(ProbeReasonCode);
        emoteReceipts.Should().ContainSingle("the emote reached the fact stream");
        emoteExecutions.HasDurabilityFailure("req_emote_write_loss").Should().BeFalse("the expression action is not quarantined for a missing journal row");

        // ---- ARM TWO: `cut_weeds`, the same failing write, the same funnel.
        FarmhandActionCatalog.ChangesTheWorld("cut_weeds").Should().BeTrue("cutting a weed changes the world");
        var weedPersistence = new FakeModGlobalDataPersistence();
        BridgeScope weedScope = CreateScope("durability-weed");
        FarmhandCapabilityPublication weedPublication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "cut_weeds" });
        var weedReceipts = new List<LocalExecutionReceipt>();
        var weedExecutions = new ExecutionManager(
            new DummyMonitor(),
            () => weedPublication,
            receiptPublished: weedReceipts.Add,
            executionJournal: new FarmhandExecutionJournal(weedPersistence),
            executionScope: weedScope);
        var weedRequest = new BridgeExecutionRequest(
            "req_weed_write_loss",
            "idem_weed_write_loss",
            "cut_weeds",
            new BridgeExecutionArgs { Destination = new BridgeNavigationDestinationSelector("label", "Farm", null) },
            ExpectedRevision: 0,
            DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
        weedExecutions.TryAdmitNavigation(weedRequest, "exec_weed_write_loss", out string weedAdmission).Should().BeTrue(weedAdmission);
        weedPersistence.FailWrites = true;
        ((IExecutionLedger)weedExecutions).RememberTerminal(
            weedRequest.RequestId,
            "exec_weed_write_loss",
            ExecutionState.Succeeded,
            ProbeReasonCode,
            "weeds_cut=1");

        weedExecutions.HasDurabilityFailure(weedRequest.RequestId).Should().BeTrue("a world change we could not record is the alarm");
        weedReceipts.Should().BeEmpty("an unpersisted world change never becomes a public receipt");

        const string weedToken = "durability_weed_token_0123456789a";
        var weedRouter = new FarmhandActionRouter();
        var weedSession = new BridgeSession(weedExecutions, weedRouter, weedScope, weedToken, () => weedPublication);
        weedSession.TryAuthenticate(1, CreateHelloEnvelope(weedScope, weedToken), out _, out string weedAuthReason).Should().BeTrue(weedAuthReason);
        var query = new BridgeEnvelope<BridgeExecutionReceiptQuery>(
            BridgeProtocol.Version,
            "msg_weed_query",
            "corr_weed_query",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            weedScope,
            "execution_receipt_query",
            new BridgeExecutionReceiptQuery(weedRequest.RequestId, weedRequest.IdempotencyKey));
        weedSession.TryQueryExecutionReceipt(1, query, out BridgeEnvelope<BridgeReceipt>? weedResponse, out string weedReason).Should().BeFalse();
        weedReason.Should().Be("execution_receipt_persistence_failed:persistence_write_failed");
        weedResponse.Should().BeNull();
    }

    /// <summary>
    /// One catalogue row, driven through the real funnel: admit it durably (or observe that this ingress will not), then
    /// fail the journal's writes and mint the terminal the dispatch would have minted.
    ///
    /// `Journalled` is the observation that the Mod tried to record this action at all - an action that is never
    /// journalled has no write to fail, so no persistence failure can refuse it - and `Refused` is
    /// `HasDurabilityFailure`, the quarantine <see cref="BridgeSession"/> answers
    /// `execution_receipt_persistence_failed:&lt;cause&gt;` from.
    /// </summary>
    private static (bool Journalled, bool Refused) ProbeDurability(string actionId)
    {
        var persistence = new FakeModGlobalDataPersistence();
        BridgeScope scope = CreateScope($"durability-probe-{actionId}");
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { actionId });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: scope);
        string requestId = $"req_probe_{actionId}";
        string executionId = $"exec_probe_{actionId}";
        BridgeExecutionRequest request = ProbeRequest(actionId, requestId);
        bool Journalled = request.Args.Destination is not null
            ? executions.TryAdmitNavigation(request, executionId, out _)
            : executions.TryAdmitCandidate(request, executionId, out _);
        if (!Journalled)
            return (false, false);

        persistence.FailWrites = true;
        ((IExecutionLedger)executions).RememberTerminal(requestId, executionId, ExecutionState.Succeeded, ProbeReasonCode, "native_dispatched=true");
        return (true, executions.HasDurabilityFailure(requestId));
    }

    /// <summary>
    /// The probe's request carries the arguments the row DECLARES, read from its own descriptor, so an ingress is
    /// exercised exactly as the wire shape would reach it and no action list is written here.
    /// </summary>
    private static BridgeExecutionRequest ProbeRequest(string actionId, string requestId)
    {
        IReadOnlyList<FarmhandActionArgument> declared = FarmhandActionCatalog.Registrations
            .Single(row => string.Equals(row.ActionId, actionId, StringComparison.Ordinal))
            .Descriptor?.Arguments ?? Array.Empty<FarmhandActionArgument>();
        bool declares(string name) => declared.Any(argument => string.Equals(argument.Name, name, StringComparison.Ordinal));
        return new BridgeExecutionRequest(
            requestId,
            $"idem_probe_{actionId}",
            actionId,
            new BridgeExecutionArgs
            {
                Destination = declares("destination") ? new BridgeNavigationDestinationSelector("label", "Mine", null) : null,
                Emote = declares("emote") ? FarmhandActionCatalog.EmoteEnum[0] : null,
                Direction = declares("direction") ? FarmhandActionCatalog.DirectionEnum[0] : null,
            },
            ExpectedRevision: 0,
            DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
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
        BridgeExecutionArgs args) =>
        new(
            BridgeProtocol.Version,
            $"msg_{requestId}",
            $"corr_{requestId}",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "execution_request",
            new BridgeExecutionRequest(requestId, idempotencyKey, action, args, ExpectedRevision: 0, DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000));

    /// <summary>
    /// Stands in for a handler whose native effect succeeded, on the real registration: the funnel is the subject, not
    /// the native call. The execution id is the one the bridge bound before routing, so the receipt matches its
    /// journalled tuple.
    /// </summary>
    private sealed class SucceededProbeHandler : IFarmhandActionHandler
    {
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatch
                && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                ? bound
                : request.RequestId;
            return ledger.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                ProbeReasonCode,
                "native_dispatched=true");
        }
    }

    /// <summary>
    /// The journal's two file operations, with the failure the live run hit: every write after the first one fails, so
    /// the admission lands and the receipt's own transition does not.
    /// </summary>
    private sealed class FakeModGlobalDataPersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;

        internal bool FailWrites { get; set; }

        internal int? WritesBeforeFailure { get; set; }

        internal FarmhandExecutionJournalState? State => this.state;

        public FarmhandExecutionJournalState? Read(string key) => this.state;

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            if (this.WritesBeforeFailure is { } budget)
            {
                if (budget <= 0)
                    return false;
                this.WritesBeforeFailure = budget - 1;
            }
            if (this.FailWrites)
                return false;

            this.state = value;
            return true;
        }
    }
}
