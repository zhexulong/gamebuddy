using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The one exemption the verifier's live-action-policy gate carries, and the two populations that keep it honest.
///
/// <para>
/// `BodyProgramVerifier` refuses a node the live policy does not enable - except when
/// <see cref="FarmhandPlanFormCatalog.IsPlanForm"/> says the id is a plan FORM, because a form is not an action and no
/// policy can enable it. The exemption is therefore exactly as safe as two facts this file derives from the Mod's own
/// catalogs rather than restating: no id the Mod registers as an ACTION is ever a form, and every id it declares as a
/// form is admitted. A member added to either catalog is examined here the moment it exists, and fails BY NAME.
/// </para>
/// <para>
/// THE OTHER HALF IS THE ROW. Admission is not permission: a form expands into ordinary dispatches, so each row's action
/// is checked against the same live policy before the router can reach a native body. Written against the real
/// <see cref="RouteReenteringBodyProgramExecutor"/> and the real <see cref="FarmhandActionRouter"/>, with the world seam
/// the only stand-in - that seam is what answers the policy at dispatch.
/// </para>
/// </summary>
public sealed class BodyProgramPlanFormPolicyTests
{
    private static readonly BodyProgramPolicyIdentity Policy = new("policy-a", 1);

    /// <summary>
    /// A node naming an id the live policy does not enable is admitted only when that id is a plan form.
    ///
    /// The set the policy enables is empty, so every id is "not enabled" and the plan-form exemption is the only thing
    /// that can admit a node. The action failure names the id that took it; the form failure names the form the Mod
    /// declares but a node cannot reach.
    /// </summary>
    [Fact]
    public void TheLivePolicyRefusesEveryActionAndAdmitsEveryPlanForm()
    {
        FarmhandBodyProgramCatalogProjectionResult projection = FarmhandBodyProgramCatalogProjection.Create();
        projection.IsPublished.Should().BeTrue(
            "the Mod's own projection must form a catalog, or every node is refused before the policy gate this file tests "
            + $"(rejections: {string.Join(",", projection.Rejections.Select(rejection => rejection.Code))})");
        BodyProgramActionCatalog catalog = projection.Catalog!;
        IReadOnlySet<string> nothingEnabled = new HashSet<string>(StringComparer.Ordinal);

        foreach (FarmhandActionRegistration action in FarmhandActionCatalog.Registrations)
        {
            BodyProgramVerificationReport report = BodyProgramVerifier.Verify(
                Program(action.ActionId, Arguments(catalog, action.ActionId)),
                catalog,
                nothingEnabled);

            report.Accepted.Should().BeFalse(
                $"'{action.ActionId}' is registered as an action and the live policy does not enable it, so a node naming it must "
                + "be refused: the only id the policy gate lets through is a plan form, and a form is not an action");
            report.Diagnostics.Should().Contain(
                diagnostic => diagnostic.Code == $"action_not_enabled:{action.ActionId}"
                    || diagnostic.Code == $"unknown_action:{action.ActionId}",
                $"the refusal must name '{action.ActionId}' with the gate that answered it (refusals: {Describe(report)})");
        }

        foreach (FarmhandActionRegistration form in FarmhandPlanFormCatalog.Registrations)
        {
            catalog.TryGetAction(form.ActionId, out _).Should().BeTrue(
                $"'{form.ActionId}' is a plan form this Mod declares, so it must be a Body Program catalog member: a form outside "
                + "the catalog is refused as unknown_action and never reaches the executor");

            BodyProgramVerificationReport report = BodyProgramVerifier.Verify(
                Program(form.ActionId, Arguments(catalog, form.ActionId)),
                catalog,
                nothingEnabled);

            report.Accepted.Should().BeTrue(
                $"'{form.ActionId}' is a plan form, so it is admitted as a form even though nothing is enabled - it is not an "
                + $"action, so the live action policy has no say about it (refusals: {Describe(report)})");
        }
    }

    /// <summary>
    /// Every row the form expands carries the live policy's answer, and that answer is consulted BEFORE the router.
    ///
    /// The control comes first: with the same harness and the row's action enabled, one row really does reach the handler.
    /// Then, with the policy enabling nothing, every action the Mod registers is refused by name and the handler sees no
    /// request at all - a loop cannot reach a native body a flat request could not.
    /// </summary>
    [Fact]
    public void EveryRowsActionIsPolicyCheckedBeforeTheRouter()
    {
        var handler = new RecordingHandler();
        var router = new FarmhandActionRouter();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations.Where(
                     registration => registration.Kind == FarmhandOperationKind.Execution && registration.HandlerGroup is not null))
            router.Register(registration, handler);
        var world = new ForEachWorld();
        var executor = new RouteReenteringBodyProgramExecutor(router, new StubLedger(), forEachWorld: _ => world);

        // A row whose action declares neither an argument nor a target family is dispatched by its tile alone, so the only
        // thing standing between it and the handler is the policy gate this file is about.
        FarmhandActionRegistration dispatchable = FarmhandActionCatalog.Registrations.First(registration =>
            registration.Kind == FarmhandOperationKind.Execution
            && registration.HandlerGroup is not null
            && registration.Descriptor is { TargetFamily: null, Arguments.Count: 0 });
        world.Enable(dispatchable.ActionId);
        NodeExecutionBinding control = Binding("control");
        BodyProgramTerminalResult? controlled = executor.Execute(Grant(dispatchable.ActionId, control), control);
        controlled!.Outcome.Should().Be(
            BodyProgramNodeOutcome.Succeeded,
            $"the harness must be able to dispatch a row at all, or 'nothing was dispatched' proves nothing (failure: {controlled.FailureCode})");
        handler.Requests.Should().ContainSingle(request => request.Action == dispatchable.ActionId);
        handler.Requests.Clear();

        world.EnableNothing();
        foreach (FarmhandActionRegistration action in FarmhandActionCatalog.Registrations)
        {
            NodeExecutionBinding binding = Binding(action.ActionId);
            BodyProgramTerminalResult? terminal = executor.Execute(Grant(action.ActionId, binding), binding);

            terminal.Should().NotBeNull();
            terminal!.Outcome.Should().Be(
                BodyProgramNodeOutcome.Failed,
                $"the row naming '{action.ActionId}' was not enabled by the live policy, so the node must settle as a refusal rather than as an effect that ran");
            terminal.FailureCode.Should().Be(
                $"row_action_not_enabled:{action.ActionId}",
                $"a row naming '{action.ActionId}' is an ordinary dispatch, so the live policy that does not enable it must "
                + "refuse that row by name - the form's exemption is the form's alone");
        }

        handler.Requests.Should().BeEmpty(
            "every row's policy answer is consulted before the router, so no row the live policy disables can reach a native body");
    }

    /// <summary>
    /// The world seam, answering the one question this file is about, with a switch the control turns.
    ///
    /// It reports a real row for the tile the loop addresses: a pass with no rows would answer `for_each_no_rows` and this
    /// file would never reach the dispatch it is testing.
    /// </summary>
    private sealed class ForEachWorld : IFarmhandForEachWorld
    {
        private string? enabled;

        public void Enable(string actionId) => this.enabled = actionId;

        public void EnableNothing() => this.enabled = null;

        public FarmhandForEachRow? ReadRow(int x, int y, int localColumn, int localRow) => new(
            x,
            y,
            localColumn,
            localRow,
            new ReadOnlyDictionary<string, FarmhandForEachValue>(new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)));

        public string? ActionForKind(string kind) => null;

        public string? TargetIdFor(string family, int x, int y, IReadOnlyDictionary<string, string>? declaredArguments) => null;

        // No family at all: this stub names no tile, so every row that needs an identity is refused for the same reason
        // whether the family is derivable or not, and no test in this file depends on which.
        public bool CanNameFamily(string family) => false;

        public bool IsActionEnabled(string actionId) => string.Equals(actionId, this.enabled, StringComparison.Ordinal);

        public bool StopRequested => false;
    }

    private static ActionProgramCandidate Program(string actionId, IReadOnlyDictionary<string, BodyProgramRuntimeValue> arguments) =>
        new("program", new[]
        {
            new ActionProgramCandidateNode(
                "node",
                actionId,
                arguments,
                Array.Empty<string>(),
                new ReadOnlyDictionary<string, ActionProgramBinding>(new Dictionary<string, ActionProgramBinding>(StringComparer.Ordinal))),
        });

    /// <summary>
    /// The node's arguments, lifted from the descriptor the catalog itself holds: a kind this file does not know how to
    /// spell fails here rather than silently leaving the node short an argument.
    /// </summary>
    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> Arguments(BodyProgramActionCatalog catalog, string actionId)
    {
        var arguments = new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal);
        if (!catalog.TryGetAction(actionId, out BodyProgramActionDescriptor? descriptor)) return arguments;
        foreach (BodyProgramArgumentDescriptor argument in descriptor!.Arguments) arguments[argument.Name] = ValueFor(argument.Kind);
        return arguments;
    }

    private static BodyProgramRuntimeValue ValueFor(BodyProgramArgumentKind kind) => kind switch
    {
        BodyProgramArgumentKind.Integer => new("integer", "0"),
        BodyProgramArgumentKind.String => new("string", "{}"),
        BodyProgramArgumentKind.Boolean => new("boolean", "false"),
        BodyProgramArgumentKind.DestinationSelector => new(
            "destination_selector",
            Destination: new BodyProgramDestinationSelector("label", "the plan form's own destination", null)),
        _ => throw new InvalidOperationException($"a node argument cannot be a {kind}"),
    };

    private static string Describe(BodyProgramVerificationReport report) =>
        report.Diagnostics.Count == 0 ? "none" : string.Join(",", report.Diagnostics.Select(diagnostic => diagnostic.Code));

    private static NodeExecutionBinding Binding(string suffix) => new(
        "program",
        "loop",
        NodeAttempt: 1,
        RequestId: $"req_{suffix}",
        IdempotencyKey: $"idem_{suffix}",
        ExecutionId: $"exec_{suffix}");

    /// <summary>
    /// One admitted `for_each` node whose single row names <paramref name="rowActionId"/>.
    ///
    /// The grant carries exactly the one argument the form declares, because that is what an admitted node carries: a
    /// reader that accepted more would be accepting a declaration nobody honours.
    /// </summary>
    private static HostAdmissionGrant Grant(string rowActionId, NodeExecutionBinding binding) => new(
        binding.ProgramId,
        binding.NodeId,
        binding.NodeAttempt,
        AdmissionAttempt: 1,
        StopEpoch: 0,
        CatalogRevision: 7,
        Policy,
        FarmhandPlanFormCatalog.ForEachActionId,
        new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
        {
            [FarmhandForEachArguments.LoopArgument] = new(BodyProgramArgumentKind.String, LoopDocument(rowActionId)),
        },
        new Dictionary<string, string>(StringComparer.Ordinal),
        DeadlineMs: 1000,
        GrantId: $"grant_{rowActionId}",
        AttachmentGeneration: "attachment_01",
        PolicyRevision: "host-policy_01",
        ExecutionBinding: binding);

    private static string LoopDocument(string rowActionId) => string.Create(
        CultureInfo.InvariantCulture,
        $"{{\"source\":{{\"area\":{{\"x\":0,\"y\":0,\"w\":1,\"h\":1}}}},\"do\":{{\"action\":\"{rowActionId}\"}}}}");

    private sealed class RecordingHandler : IFarmhandActionHandler
    {
        public List<BridgeExecutionRequest> Requests { get; } = new();

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            this.Requests.Add(request);
            return ledger.RememberTerminal(request.RequestId, request.RequestId, ExecutionState.Succeeded, "recorded", "recorded=1");
        }
    }

    private sealed class StubLedger : IExecutionLedger, IDispatchExecutionLedger
    {
        private readonly Dictionary<string, LocalExecutionReceipt> receipts = new(StringComparer.Ordinal);

        public long CurrentRevision { get; private set; } = 1;

        public bool IsBodyBusy => false;

        public bool TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode)
        {
            reasonCode = "bound";
            return true;
        }

        public bool TryGetBoundExecutionId(string requestId, out string executionId)
        {
            executionId = requestId;
            return true;
        }

        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt) => this.receipts.TryGetValue(requestId, out receipt!);

        public void BindAction(string requestId, string actionId) { }

        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt) => this.receipts[receipt.RequestId] = receipt;

        public LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation = null)
        {
            var receipt = new LocalExecutionReceipt(executionId, requestId, state, reasonCode, ++this.CurrentRevision, evidence, Observation: observation);
            this.receipts[requestId] = receipt;
            return receipt;
        }

        public void AddTrace(LocalExecutionReceipt receipt) { }
    }
}
