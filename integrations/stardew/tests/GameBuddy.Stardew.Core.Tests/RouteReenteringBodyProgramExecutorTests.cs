using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// T3.5: the uniform Body Program executor re-enters the single Mod dispatch
/// table (FarmhandActionRouter) instead of introducing a second actionId→native
/// mapping. These tests drive the real router with the real machine_inspect
/// registration and a stub ledger/handler that mirror the ordinary dispatch
/// path, and assert the exact terminal projection contract.
/// </summary>
public sealed class RouteReenteringBodyProgramExecutorTests
{
    private static readonly BodyProgramPolicyIdentity Policy = new("policy-a", 1);
    private static readonly BridgeScope Scope = new("stardew", "save", "world", "player", "companion");

    private sealed class StubLedger : IExecutionLedger, IDispatchExecutionLedger
    {
        private readonly Dictionary<string, LocalExecutionReceipt> receipts = new(StringComparer.Ordinal);
        public long CurrentRevision { get; set; } = 1;
        public bool IsBodyBusy { get; set; }
        public string? BoundActionId { get; private set; }
        public string? BoundExecutionId { get; private set; }
        public bool TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode)
        {
            if (BoundExecutionId is not null)
            {
                reasonCode = "execution_identity_conflict";
                return false;
            }
            BoundActionId = actionId;
            BoundExecutionId = executionId;
            reasonCode = "bound";
            return true;
        }
        public bool TryGetBoundExecutionId(string requestId, out string executionId)
        {
            executionId = BoundExecutionId!;
            return BoundExecutionId is not null;
        }
        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt) => this.receipts.TryGetValue(requestId, out receipt!);
        public void BindAction(string requestId, string actionId) => this.BoundActionId = actionId;
        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt) => this.receipts[receipt.RequestId] = receipt;
        public LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation = null)
        {
            var receipt = new LocalExecutionReceipt(executionId, requestId, state, reasonCode, ++this.CurrentRevision, evidence, Observation: observation);
            this.receipts[requestId] = receipt;
            return receipt;
        }
        public void AddTrace(LocalExecutionReceipt receipt) { }
    }

    /// <summary>
    /// Mirrors ordinary dispatch: a registered handler that reads the bound
    /// execution identity and returns a terminal receipt with action-owned
    /// evidence. For machine_inspect it returns Succeeded with a live-state
    /// evidence string, exactly like the native producer.
    /// </summary>
    private sealed class MachineInspectStubHandler : IFarmhandActionHandler
    {
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatchLedger
                && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
                ? boundExecutionId
                : "exec_unbound";
            return ledger.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "machine_inspected",
                "location=town;target=machine-inspect-target-1;tile=(1,1);machine=Keg;ready_for_harvest=false;minutes_until_ready=0;held=;last_input=",
                observation: null);
        }
    }

    private static FarmhandActionRegistration MachineInspectRegistration() =>
        FarmhandActionCatalog.Registrations.First(registration => string.Equals(registration.ActionId, "machine_inspect", StringComparison.Ordinal));

    private static HostAdmissionGrant Grant(
        string expectedTargetId,
        string programId = "program",
        string nodeId = "inspect",
        BodyProgramPolicyIdentity? policy = null) => new(
        programId,
        nodeId,
        NodeAttempt: 1,
        AdmissionAttempt: 1,
        StopEpoch: 0,
        CatalogRevision: 7,
        policy ?? Policy,
        "machine_inspect",
        new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
        {
            ["x"] = new(BodyProgramArgumentKind.Integer, "1"),
            ["y"] = new(BodyProgramArgumentKind.Integer, "1"),
            ["expectedTargetId"] = new(BodyProgramArgumentKind.String, expectedTargetId),
        },
        new Dictionary<string, string>(StringComparer.Ordinal),
        DeadlineMs: 1000,
        GrantId: "grant-inspect-1",
        AttachmentGeneration: "attachment_01",
        PolicyRevision: "host-policy_01",
        ExecutionBinding: Binding(programId, nodeId));

    private static NodeExecutionBinding Binding(string programId = "program", string nodeId = "inspect") =>
        new(programId, nodeId, NodeAttempt: 1, RequestId: "req_inspect_1", IdempotencyKey: "idem_inspect_1", ExecutionId: "exec_inspect_1");

    private static (FarmhandActionRouter Router, StubLedger Ledger) RouterWithMachineInspect(IFarmhandActionHandler? handler = null)
    {
        var router = new FarmhandActionRouter();
        router.Register(MachineInspectRegistration(), handler ?? new MachineInspectStubHandler());
        return (router, new StubLedger());
    }

    [Fact]
    public void MachineInspect_DispatchesThroughSharedRouter_SucceededWithExactFactAndEvidence()
    {
        (FarmhandActionRouter router, StubLedger ledger) = RouterWithMachineInspect();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        HostAdmissionGrant grant = Grant("machine-inspect-target-1");
        NodeExecutionBinding binding = Binding();

        BodyProgramTerminalResult? terminal = executor.Execute(grant, binding);

        terminal.Should().NotBeNull();
        terminal!.Outcome.Should().Be(BodyProgramNodeOutcome.Succeeded);
        terminal.Execution.Should().Be(binding);
        terminal.ReceiptId.Should().Be("exec_inspect_1", "the ReceiptId is the tuple-bound opaque note, not an invented identity");
        terminal.Evidence.Should().Contain("location=town", "evidence is the verbatim native live-state string, unparsed");
        terminal.PostconditionVerification.Should().NotBeNullOrWhiteSpace();
        ledger.BoundActionId.Should().Be("machine_inspect");
        ledger.BoundExecutionId.Should().Be("exec_inspect_1", "the dispatch identity is bound to the tuple execution id");

        RuntimeFact fact = terminal.Facts.Should().ContainSingle().Subject;
        fact.ProgramId.Should().Be("program");
        fact.NodeId.Should().Be("inspect");
        fact.NodeAttempt.Should().Be(1);
        fact.FactName.Should().Be("machine_target_id");
        fact.Values.Should().ContainKey("machine_target_id");
        fact.Values["machine_target_id"].Kind.Should().Be(BodyProgramArgumentKind.String);
        fact.Values["machine_target_id"].CanonicalValue.Should().Be("machine-inspect-target-1", "the fact value is the action-validated expectedTargetId canonical argument");
    }

    [Fact]
    public void MachineInspect_Terminal_OutcomeMapping_PreservesExactTupleProvenance()
    {
        (FarmhandActionRouter router, StubLedger ledger) = RouterWithMachineInspect();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        HostAdmissionGrant grant = Grant("machine-inspect-target-2", programId: "program-b", nodeId: "inspect-2");
        NodeExecutionBinding binding = Binding("program-b", "inspect-2");

        BodyProgramTerminalResult? terminal = executor.Execute(grant, binding);

        terminal.Should().NotBeNull();
        terminal!.Execution.ProgramId.Should().Be("program-b");
        terminal.Execution.NodeId.Should().Be("inspect-2");
        terminal.Execution.ExecutionId.Should().Be("exec_inspect_1");
        RuntimeFact fact = terminal.Facts!.Single();
        fact.ProgramId.Should().Be("program-b");
        fact.NodeId.Should().Be("inspect-2");
    }

    [Fact]
    public void UnknownAction_FailsClosed_NoFactImagination()
    {
        // Router has only machine_inspect registered; an unknown action cannot
        // be dispatched, so the executor returns a non-success terminal.
        (FarmhandActionRouter router, StubLedger ledger) = RouterWithMachineInspect();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        NodeExecutionBinding binding = new("p", "node", 1, "req_x", "idem_x", "exec_x");
        HostAdmissionGrant grant = new(
            "p", "node", 1, 1, 0, 7, Policy, "no_such_action",
            new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal), 1000,
            "grant-x", "attachment_01", "host-policy_01", binding);

        BodyProgramTerminalResult? terminal = executor.Execute(grant, binding);

        terminal.Should().NotBeNull();
        terminal!.Outcome.Should().Be(BodyProgramNodeOutcome.Failed);
        terminal.Facts.Should().BeNull("non-success terminals never carry facts or proofs");
        terminal.ReceiptId.Should().BeNull();
    }

    [Fact]
    public void MismatchedBinding_FailsClosedWithNullFacts()
    {
        (FarmhandActionRouter router, StubLedger ledger) = RouterWithMachineInspect();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        HostAdmissionGrant grant = Grant("target");
        // The presented execution does not equal the grant's own binding.
        NodeExecutionBinding mismatched = new("program", "inspect", 1, "req_other", "idem_other", "exec_other");

        BodyProgramTerminalResult? terminal = executor.Execute(grant, mismatched);

        terminal.Should().NotBeNull();
        terminal!.Outcome.Should().Be(BodyProgramNodeOutcome.Failed);
        terminal.Facts.Should().BeNull();
    }

    [Fact]
    public void NonTerminalReceipt_ReturnsNullContinuationSentinel()
    {
        var router = new FarmhandActionRouter();
        router.Register(MachineInspectRegistration(), new RunningHandler());
        var ledger = new StubLedger();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        HostAdmissionGrant grant = Grant("target");

        BodyProgramTerminalResult? terminal = executor.Execute(grant, Binding());

        terminal.Should().BeNull("a non-terminal receipt maps to the bound-Running continuation sentinel");
    }

    /// <summary>Handlers reports the native body is still running (multi-tick traversal).</summary>
    private sealed class RunningHandler : IFarmhandActionHandler
    {
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatchLedger
                && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
                ? boundExecutionId
                : "exec_unbound";
            return ledger.RememberTerminal(request.RequestId, executionId, ExecutionState.Running, "controller_started", "route_revision=1;target=(1,1)");
        }
    }

    /// <summary>
    /// Mirrors the navigate dispatch shape: reads the typed destination selector
    /// from the wire args and settles Succeeded/navigation_completed with
    /// target-version live-state evidence, exactly like the native navigation
    /// producer.
    /// </summary>
    private sealed class NavigateStubHandler : IFarmhandActionHandler
    {
        public BridgeNavigationDestinationSelector? SeenDestination { get; private set; }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            this.SeenDestination = request.Args.Destination;
            string executionId = ledger is IDispatchExecutionLedger dispatchLedger
                && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
                ? boundExecutionId
                : "exec_unbound";
            return ledger.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "navigation_completed",
                "destination=Town;location=Town;arrived=true;postcondition=true");
        }
    }

    private static FarmhandActionRegistration NavigateRegistration() =>
        FarmhandActionCatalog.Registrations.First(registration => string.Equals(registration.ActionId, "navigate_to_destination", StringComparison.Ordinal));

    private static (FarmhandActionRouter Router, StubLedger Ledger, NavigateStubHandler Handler) RouterWithNavigate()
    {
        var handler = new NavigateStubHandler();
        var router = new FarmhandActionRouter();
        router.Register(NavigateRegistration(), handler);
        return (router, new StubLedger(), handler);
    }

    private static HostAdmissionGrant NavigateGrant(string programId = "program", string nodeId = "navigate") => new(
        programId,
        nodeId,
        NodeAttempt: 1,
        AdmissionAttempt: 1,
        StopEpoch: 0,
        CatalogRevision: 7,
        Policy,
        "navigate_to_destination",
        new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
        {
            ["destination"] = new(BodyProgramArgumentKind.DestinationSelector, null, new BodyProgramDestinationSelector("label", "Town", null)),
        },
        new Dictionary<string, string>(StringComparer.Ordinal),
        DeadlineMs: 1000,
        GrantId: "grant-navigate-1",
        AttachmentGeneration: "attachment_01",
        PolicyRevision: "host-policy_01",
        ExecutionBinding: Binding(programId, nodeId));

    [Fact]
    public void Navigate_ProjectsTypedDestinationSelectorOntoWireArgs()
    {
        (FarmhandActionRouter router, StubLedger ledger, NavigateStubHandler handler) = RouterWithNavigate();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        HostAdmissionGrant grant = NavigateGrant();
        NodeExecutionBinding binding = Binding("program", "navigate");

        BodyProgramTerminalResult? terminal = executor.Execute(grant, binding);

        terminal.Should().NotBeNull();
        terminal!.Outcome.Should().Be(BodyProgramNodeOutcome.Succeeded);
        handler.SeenDestination.Should().NotBeNull();
        handler.SeenDestination!.Kind.Should().Be("label");
        handler.SeenDestination.Label.Should().Be("Town");
        handler.SeenDestination.Ref.Should().BeNull();
    }

    [Fact]
    public void Navigate_EmitsTypedArrivalFactFromValidatedSelector()
    {
        (FarmhandActionRouter router, StubLedger ledger, _) = RouterWithNavigate();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        HostAdmissionGrant grant = NavigateGrant();
        NodeExecutionBinding binding = Binding("program", "navigate");

        BodyProgramTerminalResult? terminal = executor.Execute(grant, binding);

        terminal.Should().NotBeNull();
        RuntimeFact fact = terminal!.Facts.Should().ContainSingle().Subject;
        fact.FactName.Should().Be("arrival");
        fact.Values["arrival"].Kind.Should().Be(BodyProgramArgumentKind.DestinationArrival);
        fact.Values["arrival"].Destination.Should().BeNull();
        fact.Values["arrival"].Arrival.Should().NotBeNull();
        fact.Values["arrival"].Arrival!.Reason.Should().Be("destination_arrived");
        fact.Values["arrival"].Arrival!.Destination.Label.Should().Be("Town");
    }

    [Fact]
    public void Navigate_RefSelectorWithoutLabel_FailsClosedNoFact()
    {
        (FarmhandActionRouter router, StubLedger ledger, NavigateStubHandler handler) = RouterWithNavigate();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        HostAdmissionGrant grant = new(
            "program", "navigate", 1, 1, 0, 7, Policy, "navigate_to_destination",
            new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
            {
                ["destination"] = new(BodyProgramArgumentKind.DestinationSelector, null, new BodyProgramDestinationSelector("ref", null, "dr1_AAAAAAAAAAAAAAAAAAAAAA")),
            },
            new Dictionary<string, string>(StringComparer.Ordinal), 1000,
            "grant-navigate-ref", "attachment_01", "host-policy_01", Binding("program", "navigate"));

        // An opaque ref selector is not a label; the wire projection passes the
        // ref through (runtime navigation resolves it), but the typed arrival
        // fact requires a stable label and must not fabricate one.
        BodyProgramTerminalResult? terminal = executor.Execute(grant, Binding("program", "navigate"));

        terminal.Should().NotBeNull();
        terminal!.Outcome.Should().Be(BodyProgramNodeOutcome.Succeeded);
        handler.SeenDestination.Should().NotBeNull();
        handler.SeenDestination!.Kind.Should().Be("ref");
        terminal.Facts.Should().BeSameAs(Array.Empty<RuntimeFact>(), "an unavailable label must not be fabricated into an arrival fact");
    }

    [Fact]
    public void Navigate_InvalidDestinationSelector_FailsClosedBeforeDispatch()
    {
        (FarmhandActionRouter router, StubLedger ledger, NavigateStubHandler handler) = RouterWithNavigate();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        HostAdmissionGrant grant = new(
            "program", "navigate", 1, 1, 0, 7, Policy, "navigate_to_destination",
            new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
            {
                ["destination"] = new(BodyProgramArgumentKind.DestinationSelector, null, new BodyProgramDestinationSelector("label", null, null)),
            },
            new Dictionary<string, string>(StringComparer.Ordinal), 1000,
            "grant-navigate-bad", "attachment_01", "host-policy_01", Binding("program", "navigate"));

        BodyProgramTerminalResult? terminal = executor.Execute(grant, Binding("program", "navigate"));

        terminal.Should().NotBeNull();
        terminal!.Outcome.Should().Be(BodyProgramNodeOutcome.Failed);
        terminal.Facts.Should().BeNull();
        handler.SeenDestination.Should().BeNull("the invalid selector must never reach the native dispatch");
    }

    [Fact]
    public void NonTerminalReceipt_ReRouting_ReturnsSameReceiptWithoutReExecuting()
    {
        var router = new FarmhandActionRouter();
        router.Register(MachineInspectRegistration(), new RunningHandler());
        var ledger = new StubLedger();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        HostAdmissionGrant grant = Grant("target");
        NodeExecutionBinding binding = Binding();

        // First visit: routed and left Running.
        executor.Execute(grant, binding).Should().BeNull();
        ledger.BoundExecutionId.Should().Be("exec_inspect_1");

        // Second visit: ledger replay returns the same non-terminal receipt
        // without re-running the handler (the ledger stores it). The executor
        // still maps it to the continuation sentinel, and the revision does not
        // advance (no new terminal was remembered).
        long revisionBeforeReplay = ledger.CurrentRevision;
        BodyProgramTerminalResult? second = executor.Execute(grant, binding);
        second.Should().BeNull();
        ledger.CurrentRevision.Should().Be(revisionBeforeReplay, "replay returns the existing receipt; no second terminal was remembered");
    }
}