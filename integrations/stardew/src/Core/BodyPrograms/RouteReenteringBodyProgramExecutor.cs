using System.Collections.ObjectModel;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// Uniform Body Program execution seam that re-enters the single Mod dispatch
/// table (<see cref="FarmhandActionRouter"/>, composed once from the closed
/// <c>FarmhandActionCatalog.Registrations</c>) instead of introducing a second
/// actionId→native mapping. A Body Program node is dispatched exactly like an
/// ordinary request: canonical arguments are projected onto the wire argument
/// shape, the dispatch identity is bound to the tuple's execution id via
/// <c>IDispatchExecutionLedger.TryBindDispatch</c>, the handler runs the same
/// native gates, and the ledger owns the receipt lineage.
///
/// Continuation semantics: the router's ledger replay is naturally idempotent —
/// re-routing the same <c>RequestId</c> returns the existing receipt instead of
/// re-running the handler. A first visit that yields a non-terminal receipt
/// (Accepted/Running and friends) maps to the pump's bound-Running continuation
/// sentinel (null), and a later tick re-routes and observes the terminal
/// receipt once the native body completes. This is exactly the T3.4 running
/// continuation seam, obtained by re-entering the single router rather than by
/// a second dispatcher.
///
/// Terminal projection honesty: evidence is the verbatim native live-state
/// string, never re-parsed. Declared output facts are produced from the
/// action-validated canonical arguments via the construction-private fact
/// source table (the frozen A→B contract: machine_inspect declares
/// machine_target_id whose value is its validated expectedTargetId), never by
/// parsing evidence. The postcondition note asserts only what this seam
/// actually verified — single-dispatcher routing on the game thread returned a
/// terminal receipt for this exact tuple; world-state freshness is the native
/// gate's evidence, which the A→B live gate (open-gameplay Task 6) proves.
/// </summary>
public sealed class RouteReenteringBodyProgramExecutor : IBodyProgramNodeExecutor
{
    private readonly FarmhandActionRouter router;
    private readonly IExecutionLedger ledger;
    private readonly IReadOnlyDictionary<string, string> outputFactArgumentSources;

    /// <summary>
    /// Construction-private fact source table: declared output fact name → name
    /// of the canonical argument that carries its action-validated value.
    /// Frozen A→B contract (card A / open-gameplay-release Task 6): machine_inspect
    /// declares machine_target_id whose value is its validated expectedTargetId.
    /// </summary>
    public static IReadOnlyDictionary<string, string> DefaultOutputFactArgumentSources { get; } =
        new ReadOnlyDictionary<string, string>(new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["machine_target_id"] = "expectedTargetId",
            ["arrival"] = "destination",
        });

    public RouteReenteringBodyProgramExecutor(
        FarmhandActionRouter router,
        IExecutionLedger ledger,
        IReadOnlyDictionary<string, string>? outputFactArgumentSources = null)
    {
        ArgumentNullException.ThrowIfNull(router);
        ArgumentNullException.ThrowIfNull(ledger);
        this.router = router;
        this.ledger = ledger;
        this.outputFactArgumentSources = outputFactArgumentSources ?? DefaultOutputFactArgumentSources;
    }

    public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
    {
        ArgumentNullException.ThrowIfNull(grant);
        ArgumentNullException.ThrowIfNull(execution);
        if (grant.ExecutionBinding is null || !Equals(execution, grant.ExecutionBinding))
            return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Failed, null, null, null, null);

        if (!TryBuildExecutionRequest(grant, execution, out BridgeExecutionRequest? request, out _))
            return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Failed, null, null, null, null);

        if (!this.router.TryRoute(request!, this.ledger, execution.ExecutionId, out LocalExecutionReceipt receipt, out _))
            return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Failed, null, null, null, null);

        return ToTerminal(grant, execution, receipt);
    }

    /// <summary>
    /// Projects the validated canonical arguments onto the wire argument shape
    /// exactly as ordinary dispatch would. Values come only from the grant's
    /// canonical arguments (already validated at verify/admission), never from
    /// parsing evidence. Unsupported argument names are ignored; a missing
    /// required wire value fails closed below by the router's own gate.
    /// The expected revision is bound to the current live execution revision
    /// (the same authority ordinary dispatch uses), never a hardcoded value.
    /// </summary>
    private bool TryBuildExecutionRequest(
        HostAdmissionGrant grant,
        NodeExecutionBinding execution,
        out BridgeExecutionRequest? request,
        out string reasonCode)
    {
        float? x = null;
        float? y = null;
        int? slot = null;
        string? expectedQualifiedItemId = null;
        string? expectedTargetId = null;
        string? emote = null;
        string? direction = null;
        BridgeNavigationDestinationSelector? destination = null;
        foreach (KeyValuePair<string, BodyProgramCanonicalValue> pair in grant.CanonicalArguments)
        {
            BodyProgramCanonicalValue value = pair.Value;
            switch (pair.Key)
            {
                case "x" when value.Kind == BodyProgramArgumentKind.Integer && long.TryParse(value.CanonicalValue, out long parsedX):
                    x = parsedX;
                    break;
                case "y" when value.Kind == BodyProgramArgumentKind.Integer && long.TryParse(value.CanonicalValue, out long parsedY):
                    y = parsedY;
                    break;
                case "slot" when value.Kind == BodyProgramArgumentKind.Integer && long.TryParse(value.CanonicalValue, out long parsedSlot):
                    slot = checked((int)parsedSlot);
                    break;
                case "expectedQualifiedItemId" when value.Kind == BodyProgramArgumentKind.String:
                    expectedQualifiedItemId = value.CanonicalValue;
                    break;
                case "expectedTargetId" when value.Kind == BodyProgramArgumentKind.String:
                    expectedTargetId = value.CanonicalValue;
                    break;
                case "emote" when value.Kind == BodyProgramArgumentKind.String:
                    emote = value.CanonicalValue;
                    break;
                case "direction" when value.Kind == BodyProgramArgumentKind.String:
                    direction = value.CanonicalValue;
                    break;
                case "destination" when value.Kind == BodyProgramArgumentKind.DestinationSelector && value.Destination is not null:
                    destination = value.Destination.Kind switch
                    {
                        "label" when BodyProgramValidation.IsValidSelector(value.Destination) => new BridgeNavigationDestinationSelector(value.Destination.Kind, value.Destination.Label, null),
                        "ref" when BodyProgramValidation.IsValidSelector(value.Destination) => new BridgeNavigationDestinationSelector(value.Destination.Kind, null, value.Destination.Ref),
                        _ => null,
                    };
                    break;
            }
        }

        if (destination is null && grant.CanonicalArguments.ContainsKey("destination"))
        {
            request = null;
            reasonCode = "invalid_destination_selector";
            return false;
        }

        request = new BridgeExecutionRequest(
            execution.RequestId,
            execution.IdempotencyKey,
            grant.ActionId,
            new BridgeExecutionArgs
            {
                X = x,
                Y = y,
                Slot = slot,
                ExpectedQualifiedItemId = expectedQualifiedItemId,
                ExpectedTargetId = expectedTargetId,
                Emote = emote,
                Direction = direction,
                Destination = destination,
            },
            this.ledger.CurrentRevision,
            grant.DeadlineMs);
        reasonCode = "accepted";
        return true;
    }

    /// <summary>
    /// Maps the router's terminal receipt to a Body Program terminal. Terminal
    /// receipts (Succeeded/Failed/Cancelled/Rejected) project immediately;
    /// non-terminal states (Accepted/Running/MeaningfulProgress/Blocked/
    /// Invalidated/PartiallySucceeded) return the null continuation sentinel so
    /// the pump keeps the tuple bound-Running and re-routes on a later tick
    /// (the ledger replay returns the same receipt without re-running the
    /// handler until it goes terminal).
    /// </summary>
    private BodyProgramTerminalResult? ToTerminal(
        HostAdmissionGrant grant,
        NodeExecutionBinding execution,
        LocalExecutionReceipt receipt)
    {
        switch (receipt.State)
        {
            case ExecutionState.Succeeded:
                IReadOnlyList<RuntimeFact>? facts = BuildDeclaredFacts(grant, execution);
                return new BodyProgramTerminalResult(
                    execution,
                    BodyProgramNodeOutcome.Succeeded,
                    facts,
                    receipt.ExecutionId,
                    receipt.Evidence,
                    $"route_reentrant_terminal:state={receipt.State}:request={receipt.RequestId}:revision={receipt.Revision}");
            case ExecutionState.Failed:
            case ExecutionState.Rejected:
                return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Failed, null, null, receipt.Evidence, null);
            case ExecutionState.Cancelled:
                return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Cancelled, null, null, receipt.Evidence, null);
            default:
                // Accepted / Running / MeaningfulProgress / Blocked / Invalidated /
                // PartiallySucceeded — the native body has not reached a terminal
                // state for this exact tuple; remain bound-Running.
                return null;
        }
    }

    /// <summary>
    /// Produces exactly the descriptor-declared output facts, each keyed by its
    /// own name with exact {ProgramId,NodeId,NodeAttempt} provenance. Values come
    /// from the action-validated canonical arguments named by the fact source
    /// table: string facts copy the source scalar value, while a
    /// <c>destination_arrival</c> fact copies the validated destination selector
    /// as a typed arrival at that destination. Never parses evidence. A declared
    /// output fact without a declared source (or without a matching canonical
    /// argument) is not fabricated — the authority's ValidFactSet then fails
    /// closed on the missing fact.
    /// </summary>
    private IReadOnlyList<RuntimeFact>? BuildDeclaredFacts(HostAdmissionGrant grant, NodeExecutionBinding execution)
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(candidate => string.Equals(candidate.ActionId, grant.ActionId, StringComparison.Ordinal));
        if (registration?.Descriptor is not { } descriptor || descriptor.OutputFacts.Count == 0)
            return Array.Empty<RuntimeFact>();

        var facts = new List<RuntimeFact>(descriptor.OutputFacts.Count);
        foreach (KeyValuePair<string, string> outputFact in descriptor.OutputFacts)
        {
            if (!this.outputFactArgumentSources.TryGetValue(outputFact.Key, out string? sourceArgument)
                || !grant.CanonicalArguments.TryGetValue(sourceArgument, out BodyProgramCanonicalValue? sourceValue))
                return Array.Empty<RuntimeFact>();
            BodyProgramArgumentKind declaredKind = outputFact.Value switch
            {
                "destination_arrival" => BodyProgramArgumentKind.DestinationArrival,
                "integer" => BodyProgramArgumentKind.Integer,
                "boolean" => BodyProgramArgumentKind.Boolean,
                "string" => BodyProgramArgumentKind.String,
                _ => BodyProgramArgumentKind.String,
            };
            if (declaredKind == BodyProgramArgumentKind.DestinationArrival)
            {
                if (sourceValue.Kind != BodyProgramArgumentKind.DestinationSelector || sourceValue.Destination is null
                    || !BodyProgramValidation.IsValidSelector(sourceValue.Destination)
                    || sourceValue.Destination.Kind != "label"
                    || sourceValue.Destination.Label is null)
                    return Array.Empty<RuntimeFact>();
                facts.Add(new RuntimeFact(
                    execution.ProgramId,
                    execution.NodeId,
                    execution.NodeAttempt,
                    outputFact.Key,
                    new ReadOnlyDictionary<string, BodyProgramCanonicalValue>(
                        new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
                        {
                            [outputFact.Key] = new BodyProgramCanonicalValue(
                                BodyProgramArgumentKind.DestinationArrival,
                                null,
                                null,
                                new BodyProgramDestinationArrival(
                                    "destination_arrived",
                                    new BodyProgramArrivalDestination(sourceValue.Destination.Label, null))),
                        })));
                continue;
            }
            if (sourceValue.Kind != BodyProgramArgumentKind.String || sourceValue.CanonicalValue is null)
                return Array.Empty<RuntimeFact>();
            facts.Add(new RuntimeFact(
                execution.ProgramId,
                execution.NodeId,
                execution.NodeAttempt,
                outputFact.Key,
                new ReadOnlyDictionary<string, BodyProgramCanonicalValue>(
                    new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
                    {
                        [outputFact.Key] = new BodyProgramCanonicalValue(BodyProgramArgumentKind.String, sourceValue.CanonicalValue),
                    })));
        }
        return facts;
    }
}