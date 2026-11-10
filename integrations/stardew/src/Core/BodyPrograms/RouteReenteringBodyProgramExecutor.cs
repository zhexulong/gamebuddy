using System.Collections.ObjectModel;
using System.Globalization;
using System.Text;
using System.Text.Json;
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
    /// <summary>
    /// How many characters one pass's aggregate answer may occupy.
    ///
    /// `BodyProgramValidation.IsOpaqueTerminalProof` admits 4096 characters of evidence, which is the only free-text
    /// channel a SUCCESSFUL node has (ADR-006: a failed node carries no evidence). The table is therefore bounded HERE,
    /// at the producer, and it states the count it left out instead of being cut off by the journal's own gate.
    /// </summary>
    private const int MaximumAggregateChars = 4096;

    private readonly FarmhandActionRouter router;
    private readonly IExecutionLedger ledger;
    private readonly IReadOnlyDictionary<string, string> outputFactArgumentSources;
    private readonly Func<string, IFarmhandForEachWorld?>? forEachWorld;

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
        IReadOnlyDictionary<string, string>? outputFactArgumentSources = null,
        Func<string, IFarmhandForEachWorld?>? forEachWorld = null)
    {
        ArgumentNullException.ThrowIfNull(router);
        ArgumentNullException.ThrowIfNull(ledger);
        this.router = router;
        this.ledger = ledger;
        this.outputFactArgumentSources = outputFactArgumentSources ?? DefaultOutputFactArgumentSources;
        // ABSENT MEANS THE FORM IS NOT EXECUTABLE HERE, and the node answers `for_each_world_unavailable` rather than
        // silently expanding over nothing: a pass with no world would report an empty table, which reads as a cleared
        // patch.
        this.forEachWorld = forEachWorld;
    }

    public BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution)
    {
        ArgumentNullException.ThrowIfNull(grant);
        ArgumentNullException.ThrowIfNull(execution);
        // Every non-success arm names WHY. Empty facts, not null: the authority refuses a null fact set for a non-success
        // outcome, so a fail-closed terminal that carried null was rejected as InvalidInput and the node ended unknown
        // instead of Failed. The reason rides `FailureCode` - never `Evidence`, which ADR-006 defines as the component
        // that licenses `succeeded` - because a bare `Failed` is a failure the companion can only retry blind.
        if (grant.ExecutionBinding is null || !Equals(execution, grant.ExecutionBinding))
            return Failed(execution, "execution_binding_mismatch");

        // A PLAN FORM IS EXPANDED, NOT DISPATCHED. Its action id names no handler and never will: one node here is one
        // pass over live rows, and each row goes through the SAME router a single node does (see `DispatchRow`).
        if (FarmhandPlanFormCatalog.IsPlanForm(grant.ActionId)) return this.ExecuteForEach(grant, execution);

        if (!TryBuildExecutionRequest(grant, execution, out BridgeExecutionRequest? request, out string projectionReason))
            return Failed(execution, projectionReason);

        if (!this.router.TryRoute(request!, this.ledger, execution.ExecutionId, out LocalExecutionReceipt receipt, out string routeReason))
            return Failed(execution, routeReason);

        return ToTerminal(grant, execution, receipt);
    }

    /// <summary>A refusal before any native dispatch: it has a reason and no effect, so it carries the reason only.</summary>
    /// <param name="hint">
    /// What the caller can act on when the reason alone is not enough - a failed `for_each` pass states its counts here,
    /// because ADR-006 gives a failed node no evidence to carry them.
    /// </param>
    /// <param name="detail">
    /// The same counts in the field a reader reads as the reason detail. `Hint` is the short form; a pass with more
    /// reasons than the hint's budget holds states them all here, and the two are produced by ONE enumeration
    /// (<see cref="ReasonsByCount"/>) so they cannot disagree about which reason is dominant.
    /// </param>
    private static BodyProgramTerminalResult Failed(NodeExecutionBinding execution, string reasonCode, string? hint = null, string? detail = null) =>
        new(execution, BodyProgramNodeOutcome.Failed, Array.Empty<RuntimeFact>(), null, null, null,
            BodyProgramValidation.IsReasonCode(reasonCode) ? reasonCode : null, hint, detail);

    /// <summary>
    /// Projects the validated canonical arguments onto the wire argument shape
    /// exactly as ordinary dispatch would. Values come only from the grant's
    /// canonical arguments (already validated at verify/admission), never from
    /// parsing evidence. Every argument the catalog declares has a wire member
    /// here — `BodyProgramArgumentProjectionTests` drives the whole catalog
    /// through this projection and fails on a declared argument whose value does
    /// not arrive, because a forgotten case used to be a silent drop: `equip_tool`
    /// program nodes reached the handler with `Tool` null and every one of them
    /// ended `invalid_tool_selector` by construction.
    /// A missing required wire value fails closed below by the router's own gate.
    /// The expected revision is bound to the current live execution revision
    /// (the same authority ordinary dispatch uses), never a hardcoded value.
    /// </summary>
    private bool TryBuildExecutionRequest(
        HostAdmissionGrant grant,
        NodeExecutionBinding execution,
        out BridgeExecutionRequest? request,
        out string reasonCode) =>
        this.TryBuildExecutionRequest(
            grant.CanonicalArguments, grant.ActionId, execution.RequestId, execution.IdempotencyKey, grant.DeadlineMs, out request, out reasonCode);

    /// <summary>
    /// The one projection from canonical arguments onto the wire's execution request, shared by a program node and by
    /// one ROW of a `for_each` pass.
    ///
    /// They are the same projection because they are the same dispatch: a row's arguments are canonical values of the
    /// row's action, and the router/handler below cannot tell the difference. A second mapping beside this one would be
    /// the second action vocabulary the whole design exists to avoid.
    /// </summary>
    private bool TryBuildExecutionRequest(
        IReadOnlyDictionary<string, BodyProgramCanonicalValue> canonicalArguments,
        string actionId,
        string requestId,
        string idempotencyKey,
        long deadlineMs,
        out BridgeExecutionRequest? request,
        out string reasonCode)
    {
        float? x = null;
        float? y = null;
        int? slot = null;
        int? leftSlot = null;
        int? rightSlot = null;
        int? colorSelection = null;
        int? quantity = null;
        int? expectedSkill = null;
        int? expectedLevel = null;
        string? tool = null;
        string? buildingType = null;
        string? text = null;
        string? responseKey = null;
        string? choice = null;
        string? expectedQualifiedItemId = null;
        string? expectedTargetId = null;
        string? chestId = null;
        string? emote = null;
        string? direction = null;
        BridgeNavigationDestinationSelector? destination = null;
        // Admission validates the KIND of every canonical value, not that an integer fits the wire's
        // int32 members, and an argument that silently fails to project is not a refusal: the handler
        // reads `?? 0` and acts on slot 0. So an out-of-range integer fails the whole projection closed
        // here, before any handler can run, instead of overflowing the tick from inside the mapping.
        if (canonicalArguments.Any(pair => pair.Value.Kind == BodyProgramArgumentKind.Integer
            && (!long.TryParse(pair.Value.CanonicalValue, out long parsedInteger) || parsedInteger is < int.MinValue or > int.MaxValue)))
        {
            request = null;
            reasonCode = "argument_out_of_range";
            return false;
        }
        foreach (KeyValuePair<string, BodyProgramCanonicalValue> pair in canonicalArguments)
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
                    slot = (int)parsedSlot;
                    break;
                case "leftSlot" when value.Kind == BodyProgramArgumentKind.Integer && long.TryParse(value.CanonicalValue, out long parsedLeftSlot):
                    leftSlot = (int)parsedLeftSlot;
                    break;
                case "rightSlot" when value.Kind == BodyProgramArgumentKind.Integer && long.TryParse(value.CanonicalValue, out long parsedRightSlot):
                    rightSlot = (int)parsedRightSlot;
                    break;
                case "colorSelection" when value.Kind == BodyProgramArgumentKind.Integer && long.TryParse(value.CanonicalValue, out long parsedColorSelection):
                    colorSelection = (int)parsedColorSelection;
                    break;
                case "quantity" when value.Kind == BodyProgramArgumentKind.Integer && long.TryParse(value.CanonicalValue, out long parsedQuantity):
                    quantity = (int)parsedQuantity;
                    break;
                case "expectedSkill" when value.Kind == BodyProgramArgumentKind.Integer && long.TryParse(value.CanonicalValue, out long parsedExpectedSkill):
                    expectedSkill = (int)parsedExpectedSkill;
                    break;
                case "expectedLevel" when value.Kind == BodyProgramArgumentKind.Integer && long.TryParse(value.CanonicalValue, out long parsedExpectedLevel):
                    expectedLevel = (int)parsedExpectedLevel;
                    break;
                case "tool" when value.Kind == BodyProgramArgumentKind.String:
                    tool = value.CanonicalValue;
                    break;
                case "buildingType" when value.Kind == BodyProgramArgumentKind.String:
                    buildingType = value.CanonicalValue;
                    break;
                case "text" when value.Kind == BodyProgramArgumentKind.String:
                    text = value.CanonicalValue;
                    break;
                case "responseKey" when value.Kind == BodyProgramArgumentKind.String:
                    responseKey = value.CanonicalValue;
                    break;
                case "choice" when value.Kind == BodyProgramArgumentKind.String:
                    choice = value.CanonicalValue;
                    break;
                case "expectedQualifiedItemId" when value.Kind == BodyProgramArgumentKind.String:
                    expectedQualifiedItemId = value.CanonicalValue;
                    break;
                case "expectedTargetId" when value.Kind == BodyProgramArgumentKind.String:
                    expectedTargetId = value.CanonicalValue;
                    break;
                // The container pair names its container through `chestId`, which IS the address: it binds
                // the location, the tile and the chest type, so there is no x/y or slot beside it. Without
                // this case a program node carrying a legal chestId reached the handler with null and was
                // refused `chest_target_changed` by construction - the same silent-drop shape `equip_tool`
                // had before its `tool` case existed.
                case "chestId" when value.Kind == BodyProgramArgumentKind.String:
                    chestId = value.CanonicalValue;
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

        if (destination is null && canonicalArguments.ContainsKey("destination"))
        {
            request = null;
            reasonCode = "invalid_destination_selector";
            return false;
        }

        request = new BridgeExecutionRequest(
            requestId,
            idempotencyKey,
            actionId,
            new BridgeExecutionArgs
            {
                X = x,
                Y = y,
                Slot = slot,
                LeftSlot = leftSlot,
                RightSlot = rightSlot,
                ColorSelection = colorSelection,
                Quantity = quantity,
                ExpectedSkill = expectedSkill,
                ExpectedLevel = expectedLevel,
                Tool = tool,
                BuildingType = buildingType,
                Text = text,
                ResponseKey = responseKey,
                Choice = choice,
                ExpectedQualifiedItemId = expectedQualifiedItemId,
                ExpectedTargetId = expectedTargetId,
                ChestId = chestId,
                Emote = emote,
                Direction = direction,
                Destination = destination,
            },
            this.ledger.CurrentRevision,
            deadlineMs);
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
        return ToTerminal(grant, execution, receipt, receipt.State);
    }

    /// <summary>
    /// The receipt-state to outcome mapping, separated from <see cref="ToTerminal(HostAdmissionGrant, NodeExecutionBinding, LocalExecutionReceipt)"/>
    /// so a test can ask it directly which states settle a node.
    ///
    /// <para>
    /// The `default` arm is the load-bearing one: it answers `null`, which the controller reads as "keep waiting". That
    /// is correct ONLY for the states that mean the native body has not finished this attempt. `Blocked`, `Invalidated`
    /// and `Expired` were in it, and all three are decisions the Mod already declares terminal in
    /// `ModEntry.IsUnconfirmedTerminal` - so a node the delivery tracker had given up on stayed bound-Running for the
    /// rest of the run (measured 2026-10-30, `round9`).
    /// </para>
    /// </summary>
    internal static BodyProgramNodeOutcome? OutcomeForTerminalState(ExecutionState state) =>
        state switch
        {
            ExecutionState.Succeeded => BodyProgramNodeOutcome.Succeeded,
            ExecutionState.Failed => BodyProgramNodeOutcome.Failed,
            ExecutionState.Rejected => BodyProgramNodeOutcome.Failed,
            ExecutionState.Cancelled => BodyProgramNodeOutcome.Cancelled,
            ExecutionState.Uncertain => BodyProgramNodeOutcome.Uncertain,
            ExecutionState.PartiallySucceeded => BodyProgramNodeOutcome.Failed,
            ExecutionState.Blocked => BodyProgramNodeOutcome.Failed,
            ExecutionState.Invalidated => BodyProgramNodeOutcome.Cancelled,
            ExecutionState.Expired => BodyProgramNodeOutcome.Failed,
            // Accepted / Running / MeaningfulProgress: the native body has not finished this exact tuple. Nothing else
            // may reach here - a state added to `ModEntry.IsUnconfirmedTerminal` must gain an arm above, or it reads as
            // an unfinished attempt.
            _ => null,
        };

    private BodyProgramTerminalResult? ToTerminal(
        HostAdmissionGrant grant,
        NodeExecutionBinding execution,
        LocalExecutionReceipt receipt,
        ExecutionState state)
    {
        BodyProgramNodeOutcome? outcome = OutcomeForTerminalState(state);
        if (outcome is null) return null;
        switch (outcome.Value)
        {
            case BodyProgramNodeOutcome.Succeeded:
                IReadOnlyList<RuntimeFact>? facts = BuildDeclaredFacts(grant, execution);
                return new BodyProgramTerminalResult(
                    execution,
                    BodyProgramNodeOutcome.Succeeded,
                    facts,
                    receipt.ExecutionId,
                    receipt.Evidence,
                    $"route_reentrant_terminal:state={receipt.State}:request={receipt.RequestId}:revision={receipt.Revision}");
            case BodyProgramNodeOutcome.Cancelled:
                // A cancellation is still a settlement, and the receipt that produced one may state why (`Invalidated`
                // arrives here through the default arm below). Its reason detail belongs on the node; its evidence does
                // not, because nothing was proved.
                return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Cancelled, Array.Empty<RuntimeFact>(), null, null, null, receipt.ReasonCode, null, receipt.Evidence);
            case BodyProgramNodeOutcome.Uncertain:
                // A terminal the action minted: it ran, and its own postcondition could not confirm the effect. It must
                // NOT be retried (the side effect may already exist), so it settles the node as the unknown it is. Its
                // reason is `RecoveryDiagnostic`, not `FailureCode`: the outcome is unknown, not a known non-effect.
                return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Uncertain, Array.Empty<RuntimeFact>(), null, null, null);
            default:
                // Failed, and the authority refuses this shape for a non-success outcome: `TryComplete` requires Facts
                // to be a non-null (empty) set and ReceiptId/Evidence/PostconditionVerification to be absent, because a
                // node that claims no effect must not present proof of one. Sending `null` facts WITH evidence made
                // every Failed/Rejected node fail that gate as InvalidInput, and the controller then replaced it with an
                // unknown settlement - which is how a one-frame animation cooldown (`player_not_actionable`) quarantined
                // a whole save scope (measured 2026-10-19: node h2 of east_harvest, on disk).
                //
                // The receipt's own reason code DOES travel, in `FailureCode`. It was dropped here, so `door_out_of_range`
                // reached the companion as a bare `Failed` and it re-sent the same doomed node; the reason is a statement
                // about why nothing happened, not proof that something did, so it cannot be confused with the evidence
                // the success path requires.
                //
                // The receipt's EVIDENCE travels too - as `RefusalDetail`, never as `Evidence`. That is the whole of
                // round41's defect: `shop_purchase` refused `shop_counter_out_of_reach` six times while
                // `owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1` sat in this receipt, and the model received the
                // reason code alone and invented the world fact it needed. ADR-006's ban is on evidence for a node that
                // claims no effect; a reason detail is the same statement the reason code makes, one level down.
                return new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Failed, Array.Empty<RuntimeFact>(), null, null, null, receipt.ReasonCode, receipt.Hint, receipt.Evidence);
        }
    }

    /// <summary>
    /// Expands one `for_each` node into a pass over the live rows its source yields.
    ///
    /// <para>
    /// NOTHING IS DISPATCHED BY THE FORM. Every row is decided by <see cref="FarmhandForEachRules"/> against the world as
    /// it is NOW and then handed to <see cref="FarmhandForEachExpansion"/> with a delegate that re-enters the SAME router
    /// a single node uses - so a loop cannot reach a native body a flat request could not, and the handler's own gates
    /// run exactly as they do for one action.
    /// </para>
    /// <para>
    /// THE ANSWER IS THE AGGREGATE, one row per row: counts, the rows themselves, and the omissions the bounds made. A
    /// success claims it only when every row that was not deliberately left alone did the thing and proved it.
    /// </para>
    /// </summary>
    private BodyProgramTerminalResult? ExecuteForEach(HostAdmissionGrant grant, NodeExecutionBinding execution)
    {
        if (!FarmhandForEachArguments.TryParse(grant.CanonicalArguments, out FarmhandForEachLoop? loop, out string parseReasonCode))
            return Failed(execution, parseReasonCode);
        IFarmhandForEachWorld? world = this.forEachWorld?.Invoke(grant.ProgramId);
        if (world is null) return Failed(execution, ForEachWorldUnavailable);

        var rows = new List<FarmhandForEachRow>();
        var outsideFarm = new List<(int LocalRow, int LocalColumn, string Json)>();
        foreach ((int x, int y, int localColumn, int localRow) in FarmhandForEachRules.AreaRows(loop!.Source))
        {
            FarmhandForEachRow? row = world.ReadRow(x, y, localColumn, localRow);
            if (row is not null)
            {
                rows.Add(row);
                continue;
            }
            // A rectangle may reach past the farm's own edge. Such a tile is NOT a row - there is nothing there to act on -
            // and it is still in the table by name, because a tile missing from the answer reads as one the pass forgot.
            outsideFarm.Add((localRow, localColumn, RowJson(x, y, null, NotOnFarmState, TileOutsideFarmReason, null)));
        }

        FarmhandForEachDispatch dispatch = (FarmhandForEachTarget target, string requestId, string executionId, out LocalExecutionReceipt receipt, out string reasonCode) =>
            this.DispatchRow(world, target, requestId, executionId, grant.DeadlineMs, out receipt, out reasonCode);

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, execution.RequestId, rows, dispatch, () => world.StopRequested, world.IsActionEnabled);

        var table = new List<(int LocalRow, int LocalColumn, string Json)>(outsideFarm);
        foreach (FarmhandForEachTargetResult result in pass.Targets)
            table.Add((result.LocalRow, result.LocalColumn, RowJson(result.X, result.Y, result.Target?.ActionId, StateOf(result.Outcome), result.ReasonCode, result.Healed, result.Steps, result.StoppedAt)));

        // A PASS THAT HAS NOT FINISHED IS NOT AN ANSWER. The native body still owns the embodied actor, so the node stays
        // bound-Running and a later tick re-enters this same pass: the row identities are deterministic, so the router
        // answers the settled rows with the receipts it already recorded and the pass continues from the busy one.
        ForEachPassVerdict verdict = VerdictFor(pass);
        if (verdict == ForEachPassVerdict.Continue) return null;
        if (verdict == ForEachPassVerdict.Cancelled)
            return new BodyProgramTerminalResult(
                execution, BodyProgramNodeOutcome.Cancelled, Array.Empty<RuntimeFact>(), null, null, null, ForEachStoppedReason,
                FailureHint(pass), FailureDetail(pass));
        if (verdict is ForEachPassVerdict.NoRows or ForEachPassVerdict.Failed)
            return Failed(execution, verdict == ForEachPassVerdict.NoRows ? NoRowsReason : DominantReason(pass), FailureHint(pass), FailureDetail(pass));

        int rowsOmitted = 0;
        string aggregate = Aggregate(pass, table, StateToken(verdict), ref rowsOmitted);
        // A PARTIAL PASS IS NOT A POLITE SUCCESS. It carries the proof of the rows that did happen (the same aggregate a
        // full pass carries, whose `state` says which verdict this is) AND the dominant reason plus the counts for the
        // rows that did not, in the same two fields a failed pass uses. That is the whole answer the caller needs: what
        // got done, and which tiles did not and why - stated on one node, so the next plan does not have to discover it.
        if (verdict == ForEachPassVerdict.PartiallySucceeded)
            return new BodyProgramTerminalResult(
                execution,
                BodyProgramNodeOutcome.PartiallySucceeded,
                Array.Empty<RuntimeFact>(),
                // A pass that dispatched nothing (every row a deliberate path) has no row receipt, and its own dispatch
                // identity is the lineage a reader needs to find this attempt.
                LastReceiptId(pass) ?? execution.ExecutionId,
                aggregate,
                $"for_each_pass:partially_succeeded:decided={pass.Decided}:succeeded={pass.Succeeded}:failed={pass.Failed}:refused={pass.Refused}",
                DominantReason(pass),
                FailureHint(pass),
                FailureDetail(pass));
        return new BodyProgramTerminalResult(
            execution,
            BodyProgramNodeOutcome.Succeeded,
            Array.Empty<RuntimeFact>(),
            // A pass that dispatched nothing (every row a deliberate path) has no row receipt, and its own dispatch
            // identity is the lineage a reader needs to find this attempt.
            LastReceiptId(pass) ?? execution.ExecutionId,
            aggregate,
            $"for_each_pass:decided={pass.Decided}:succeeded={pass.Succeeded}:left_alone={pass.LeftAlone}:omitted={pass.Omitted}");
    }

    /// <summary>
    /// What one pass's own counts decide about the node, as ONE function so a test can ask it directly and a gate can
    /// enumerate every pass shape the row outcomes can produce.
    ///
    /// <para>
    /// THE VERDICT IS NOT ALL-OR-NOTHING. A pass decides every row on its own, so a single refused row must not cancel
    /// the fifty-nine that worked: the node settles <see cref="BodyProgramNodeOutcome.PartiallySucceeded"/> and the reason
    /// for the refused rows rides `FailureCode`/`Hint`/`RefusalDetail` beside the aggregate. Measured `round44`: a
    /// 60-row `cut_weeds` strip answered `decided=60;succeeded=0;failed=0;refused=60` because the identity seam could not
    /// name a weed; the run that followed from a single refused row among clear ones was the companion concluding "batch
    /// loops are unreliable, write one tile at a time" - which is what an all-or-nothing verdict teaches.
    /// </para>
    /// <para>
    /// `Deferred` is not a failure: the native body still owns the actor, so the pass keeps re-entering. `Stopped` is a
    /// cancellation of the pass, not of its settled rows. Zero succeeded rows is still `Failed` - the pass did nothing,
    /// and "nothing happened" must never read as its mild neighbour.
    /// </para>
    /// </summary>
    internal static ForEachPassVerdict VerdictFor(FarmhandForEachPassResult pass)
    {
        ArgumentNullException.ThrowIfNull(pass);
        if (pass.Deferred > 0 && pass.Failed == 0 && pass.Refused == 0 && !pass.Stopped) return ForEachPassVerdict.Continue;
        if (pass.Stopped) return ForEachPassVerdict.Cancelled;
        if (pass.Decided == 0) return ForEachPassVerdict.NoRows;
        // A pass that matched no rule did nothing, and "0 rows" is not a success: the caller asked for a patch and the
        // rows it addressed were all somebody else's. The dominant row code names what the rows actually said.
        if (pass.Succeeded == 0 && pass.LeftAlone == 0) return ForEachPassVerdict.Failed;
        if (pass.Failed > 0 || pass.Refused > 0) return pass.Succeeded > 0 ? ForEachPassVerdict.PartiallySucceeded : ForEachPassVerdict.Failed;
        return ForEachPassVerdict.Succeeded;
    }

    /// <summary>The word the aggregate's own `state` carries: the verdict, in the wire's vocabulary.</summary>
    private static string StateToken(ForEachPassVerdict verdict) => verdict switch
    {
        ForEachPassVerdict.Succeeded => "succeeded",
        ForEachPassVerdict.PartiallySucceeded => "partially_succeeded",
        _ => throw new ArgumentOutOfRangeException(nameof(verdict), verdict, "A pass that did not settle has no aggregate."),
    };

    /// <summary>
    /// One row's native effect, through the router a single node uses.
    ///
    /// The three refusals that happen BEFORE the router are the ones the router cannot express: a `by_kind` the classifier
    /// cannot resolve, an action the live policy does not enable, and an argument the action declares that this row
    /// cannot supply. Each names the thing to fix, and each is a ROW answer - never a whole-plan rejection.
    /// </summary>
    private bool DispatchRow(
        IFarmhandForEachWorld world,
        FarmhandForEachTarget target,
        string requestId,
        string executionId,
        long formDeadlineMs,
        out LocalExecutionReceipt receipt,
        out string reasonCode)
    {
        receipt = default!;
        reasonCode = "for_each_row_unavailable";
        string actionId = target.ActionId;
        if (string.Equals(actionId, FarmhandForEachStep.ByKindAction, StringComparison.Ordinal))
        {
            string kind = target.Kind ?? "unknown";
            if (world.ActionForKind(kind) is not { Length: > 0 } resolved)
            {
                reasonCode = $"no_action_for_kind:{kind}";
                return false;
            }
            actionId = resolved;
        }
        // A FORM IS ADMITTED, EACH ROW IS POLICY-CHECKED. The form bypasses the enabled set because it is not an action;
        // the rows do not, because they are.
        if (!world.IsActionEnabled(actionId))
        {
            reasonCode = $"{BodyProgramValidation.RowActionNotEnabledPrefix}{actionId}";
            return false;
        }
        if (!TryBuildRowArguments(world, target, actionId, out FarmhandActionDescriptor? descriptor, out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? canonical, out reasonCode))
            return false;
        // THE ROW'S OWN WINDOW, capped by what the pass has left. See `RowDeadlineMs`.
        long rowDeadlineMs = RowDeadlineMs(descriptor, formDeadlineMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (!this.TryBuildExecutionRequest(canonical!, actionId, requestId, requestId, rowDeadlineMs, out BridgeExecutionRequest? request, out reasonCode))
            return false;
        return this.router.TryRoute(request!, this.ledger, executionId, out receipt, out reasonCode);
    }

    /// <summary>
    /// THE DEADLINE ONE ROW IS DISPATCHED IN: its own action's published window, and never later than the pass's own.
    ///
    /// <para>
    /// Measured 2026-11-10 (`round42`, day 6): a nine-row `water_crop` loop answered `failed=1`, and that one row's failure
    /// was `invalid_deadline`. The row had inherited the FORM's grant deadline, which is
    /// <see cref="FarmhandPlanFormCatalog.WatchdogMs"/> - ten minutes, the budget of a pass over a whole patch - while
    /// <c>AdmitExecution</c> admits a deadline at most <see cref="FarmhandActionCatalog.OrdinaryActionCeilingMs"/> ahead
    /// for an ordinary action. A row that got past identity minting was therefore refused for a deadline its own action
    /// never set, and no stage of the pass could act on it.
    /// </para>
    /// <para>
    /// A ROW IS ONE ORDINARY ACTION, so its deadline is that action's own watchdog - the same number the Host reads to
    /// size a flat request and the same one the controller's ceiling is built from - and the caller's declared pass
    /// deadline still wins when it is shorter. Both halves of the live defect are answered: the declared deadline is
    /// honoured, the phantom one is gone.
    /// </para>
    /// </summary>
    internal static long RowDeadlineMs(FarmhandActionDescriptor? rowAction, long formDeadlineMs, long nowMs)
    {
        long windowMs = rowAction?.WatchdogMs is > 0 and long watchdogMs
            ? watchdogMs
            : FarmhandActionCatalog.OrdinaryActionCeilingMs;
        return Math.Min(formDeadlineMs, nowMs + windowMs);
    }

    /// <summary>
    /// One row's arguments, lifted onto the arguments the action DECLARES.
    ///
    /// <para>
    /// The declared list is the action's own descriptor, so a row cannot name an argument the action does not take, and an
    /// argument the row cannot supply is named instead of reaching the handler as null. `expectedTargetId` is the one
    /// argument this pass MINTS rather than lifts: the family the descriptor declares answers the identity of THIS tile
    /// from the world as it is now, which is the whole reason a loop can address a patch no observation ever carried.
    /// </para>
    /// <para>
    /// THE IDENTITY IS RESOLVED AFTER THE ROW'S OWN SCALARS. A `do` that omits `slot` is told that, not told that the world
    /// cannot name the tile - so the caller's arguments are lifted first and the identity is minted last, and a refusal
    /// always names the thing the caller can fix.
    /// </para>
    /// <para>
    /// A ROW WHOSE IDENTITY CANNOT BE MINTED IS REFUSED HERE, NOT DISPATCHED, and the two ways that happens are TWO
    /// words. A family this seam has no arm for answers `row_target_identity_unavailable:&lt;actionId&gt;:&lt;family&gt;` - the
    /// caller's action addresses something this pass cannot name. A family it CAN derive, over a tile that carries
    /// nothing for it, answers `row_target_absent:&lt;actionId&gt;:&lt;family&gt;` - the tile is bare and the action is fine.
    /// They answered the same code until 2026-11-10, and the live run's eight bare `water_crop` rows read as "`cropTargets`
    /// can never match" instead of "these tiles have no crop".
    /// </para>
    /// </summary>
    private static bool TryBuildRowArguments(
        IFarmhandForEachWorld world,
        FarmhandForEachTarget target,
        string actionId,
        out FarmhandActionDescriptor? descriptor,
        out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? canonical,
        out string reasonCode)
    {
        canonical = null;
        reasonCode = $"row_action_unavailable:{actionId}";
        descriptor = FarmhandActionCatalog.Registrations
            .FirstOrDefault(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))?.Descriptor;
        if (descriptor is null) return false;

        // The row's own address is not a caller argument: it comes from the row, and a `do` that also names it is refused
        // rather than silently overridden. `expectedTargetId` is refused earlier and by its own name - the loop reader
        // will not even parse a `do` that carries it (`for_each_row_identity_is_not_the_callers`) - and it is kept in this
        // list so the dispatch seam states the same rule for a caller that reached it another way.
        string[] derived = { "x", "y", ExpectedTargetIdArgument };
        if (target.Arguments is not null)
            foreach (string name in target.Arguments.Keys)
                if (Array.IndexOf(derived, name) >= 0)
                {
                    reasonCode = $"row_argument_reserved:{name}";
                    return false;
                }

        var values = new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal);
        foreach (FarmhandActionArgument argument in descriptor.Arguments)
        {
            if (string.Equals(argument.Name, ExpectedTargetIdArgument, StringComparison.Ordinal)) continue;
            if (argument.Name == "x" && target.X is { } x)
            {
                values[argument.Name] = IntegerValue(x);
                continue;
            }
            if (argument.Name == "y" && target.Y is { } y)
            {
                values[argument.Name] = IntegerValue(y);
                continue;
            }
            if (target.Arguments is not null && target.Arguments.TryGetValue(argument.Name, out string? text))
            {
                if (!TryCanonicalizeArgument(argument.Type, text, out BodyProgramCanonicalValue? value))
                {
                    reasonCode = $"row_argument_invalid:{argument.Name}";
                    return false;
                }
                values[argument.Name] = value!;
                continue;
            }
            reasonCode = $"row_argument_missing:{argument.Name}";
            return false;
        }
        if (descriptor.Arguments.Any(argument => string.Equals(argument.Name, ExpectedTargetIdArgument, StringComparison.Ordinal)))
        {
            string? family = descriptor.TargetFamily;
            string? targetId = family is null || target.X is not { } rowX || target.Y is not { } rowY
                ? null
                : world.TargetIdFor(family, rowX, rowY, target.Arguments);
            if (targetId is not { Length: > 0 })
            {
                // THREE FACTS, THREE WORDS. The family the descriptor names is the one the snapshot publishes, verbatim
                // (`FarmhandForEachFamilyDriftTests` is the gate on that spelling), so this refusal cannot be read as a
                // case mismatch - and a row over a tile that carries nothing says so instead of blaming the family. A
                // family the pass cannot address at all carries ITS OWN stated reason ("not a tile", "no reader for that
                // tile"); only a family nothing has examined falls through to the generic word, which the drift gate turns
                // red rather than the row.
                string? refusal = family is null ? null : world.RowIdentityRefusalFor(family);
                reasonCode = family is not null && world.CanNameFamily(family)
                    ? $"row_target_absent:{actionId}:{family}"
                    : $"{refusal ?? IdentityUnavailableRefusal}:{actionId}:{family ?? NoTargetFamily}";
                return false;
            }
            values[ExpectedTargetIdArgument] = new BodyProgramCanonicalValue(BodyProgramArgumentKind.String, targetId);
        }
        if (target.Arguments is not null)
            foreach (string name in target.Arguments.Keys)
                if (descriptor.Arguments.All(argument => !string.Equals(argument.Name, name, StringComparison.Ordinal)))
                {
                    reasonCode = $"row_argument_unknown:{name}";
                    return false;
                }
        canonical = values;
        reasonCode = "accepted";
        return true;
    }

    private static bool TryCanonicalizeArgument(string declaredType, string text, out BodyProgramCanonicalValue? value)
    {
        value = declaredType switch
        {
            "integer" when long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out long number)
                => new BodyProgramCanonicalValue(BodyProgramArgumentKind.Integer, number.ToString(CultureInfo.InvariantCulture)),
            "boolean" when text is "true" or "false" => new BodyProgramCanonicalValue(BodyProgramArgumentKind.Boolean, text),
            "string" => new BodyProgramCanonicalValue(BodyProgramArgumentKind.String, text),
            _ => null,
        };
        return value is not null;
    }

    private static BodyProgramCanonicalValue IntegerValue(int value) =>
        new(BodyProgramArgumentKind.Integer, value.ToString(CultureInfo.InvariantCulture));

    /// <summary>The one row's state word, in the same vocabulary every answer already uses.</summary>
    private static string StateOf(FarmhandForEachTargetOutcome outcome) => outcome switch
    {
        FarmhandForEachTargetOutcome.Succeeded => "succeeded",
        FarmhandForEachTargetOutcome.Failed => "failed",
        FarmhandForEachTargetOutcome.Deferred => "deferred",
        FarmhandForEachTargetOutcome.Refused => "refused",
        FarmhandForEachTargetOutcome.LeftAlone => "left_alone",
        FarmhandForEachTargetOutcome.Stopped => "stopped",
        _ => "not_matched",
    };

    /// <summary>
    /// One row of the pass's table, in the words the aggregate carries it in.
    ///
    /// INTERNAL SO A TEST CAN ASK THE RECEIPT ITSELF what a chained row and a one-action row look like: the two new words
    /// (`steps`, `stopped_at`) are additive only if the rows that never asked for a chain stay byte-identical, and that is a
    /// property of this formatting rather than of the pass. Same seam as <see cref="VerdictFor"/>, one level down.
    /// </summary>
    internal static string RowJson(
        int? x,
        int? y,
        string? action,
        string state,
        string? reasonCode,
        string? healed,
        IReadOnlyList<FarmhandForEachStepResult>? steps = null,
        string? stoppedAt = null) =>
        string.Create(CultureInfo.InvariantCulture,
            $"{{\"x\":{x?.ToString(CultureInfo.InvariantCulture) ?? "null"},\"y\":{y?.ToString(CultureInfo.InvariantCulture) ?? "null"},\"action\":{JsonText(action)},\"state\":\"{state}\",\"reasonCode\":{JsonText(reasonCode)},\"healed\":{JsonText(healed)}{StepsJson(steps, stoppedAt)}{StoppedAtJson(stoppedAt)}}}");

    /// <summary>
    /// The steps a row took, when it took more than one - or when it is a chain that stopped on its first step.
    ///
    /// A one-action row already says `action`/`state`/`reasonCode`, and repeating them as a list of one would grow every
    /// row of every pass that never asked for a chain to say what it already said.
    /// </summary>
    private static string StepsJson(IReadOnlyList<FarmhandForEachStepResult>? steps, string? stoppedAt)
    {
        // A ONE-STEP ROW REPEATS WHAT `action`/`state`/`reasonCode` ALREADY SAY - except when it is a CHAIN that stopped on
        // its first step, where the chain's own length is what makes `stopped_at=0:...` readable.
        if (steps is null || (steps.Count < 2 && stoppedAt is null)) return string.Empty;
        var body = new StringBuilder();
        foreach (FarmhandForEachStepResult step in steps)
        {
            if (body.Length > 0) body.Append(',');
            body.Append(CultureInfo.InvariantCulture,
                $"{{\"step\":{step.Step},\"action\":{JsonText(step.ActionId)},\"state\":\"{StateOf(step.Outcome)}\",\"reasonCode\":{JsonText(step.ReasonCode)}}}");
        }
        return string.Create(CultureInfo.InvariantCulture, $",\"steps\":[{body}]");
    }

    /// <summary>Where a row's chain stopped, on the row it happened to: `&lt;step&gt;:&lt;reasonCode&gt;`.</summary>
    private static string StoppedAtJson(string? stoppedAt) => stoppedAt is null ? string.Empty : $",\"stopped_at\":{JsonText(stoppedAt)}";

    private static string JsonText(string? value) => value is null ? "null" : JsonSerializer.Serialize(value);

    /// <summary>
    /// The pass's counts and rows, bounded to what a successful node's evidence may carry.
    ///
    /// The counts describe the PASS; <paramref name="rowsOmitted"/> describes THIS TABLE, so a reader can tell a short
    /// table from a short pass. Nothing is dropped from the counts when the table is cut.
    /// </summary>
    private static string Aggregate(FarmhandForEachPassResult pass, IReadOnlyList<(int LocalRow, int LocalColumn, string Json)> table, string state, ref int rowsOmitted)
    {
        // The step count is part of the aggregate only when a chain ran: a pass of single actions already answers `steps ==
        // decided` by construction, and every row of every existing pass would otherwise grow to say it.
        string steps = pass.Steps > pass.Decided ? string.Create(CultureInfo.InvariantCulture, $",\"steps\":{pass.Steps}") : string.Empty;
        string header = string.Create(CultureInfo.InvariantCulture,
            $"{{\"state\":\"{state}\",\"succeeded\":{pass.Succeeded},\"failed\":{pass.Failed},\"refused\":{pass.Refused},\"left_alone\":{pass.LeftAlone},\"not_matched\":{pass.NotMatched},\"deferred\":{pass.Deferred},\"omitted\":{pass.Omitted}{steps}");
        var body = new StringBuilder();
        foreach ((int _, int _, string json) in table.OrderBy(row => row.LocalRow).ThenBy(row => row.LocalColumn))
        {
            // The tail is `,"healed":NN,"rowsOmitted":NN,"rows":[]}` - 64 characters covers it with room for large counts.
            if (header.Length + body.Length + json.Length + 64 > MaximumAggregateChars)
            {
                rowsOmitted += 1;
                continue;
            }
            if (body.Length > 0) body.Append(',');
            body.Append(json);
        }
        return string.Create(CultureInfo.InvariantCulture, $"{header},\"healed\":{pass.Healed},\"rowsOmitted\":{rowsOmitted},\"rows\":[{body}]}}");
    }

    /// <summary>
    /// The reason a pass that did not succeed answers with: the code MOST of its failing rows gave, ties going to the
    /// first row that gave it, so the answer names the thing with the most occurrences to fix.
    /// </summary>
    private static string DominantReason(FarmhandForEachPassResult pass)
    {
        IReadOnlyList<(string Code, int Count)> reasons = ReasonsByCount(pass);
        return reasons.Count == 0 ? PassIncompleteReason : reasons[0].Code;
    }

    /// <summary>
    /// The reason codes a pass's non-success rows gave, most frequent first, ties going to the EARLIEST row.
    ///
    /// ONE enumeration for the two answers that need it - `FailureCode` and the hint's counts - because two groupings
    /// would eventually disagree about which reason is dominant, and a reader could not tell which the pass decided with.
    /// </summary>
    private static IReadOnlyList<(string Code, int Count)> ReasonsByCount(FarmhandForEachPassResult pass)
    {
        var counted = new List<string>();
        foreach (FarmhandForEachTargetResult result in pass.Targets)
            if (result.Outcome is not (FarmhandForEachTargetOutcome.Succeeded or FarmhandForEachTargetOutcome.LeftAlone))
                counted.Add(WireReason(result.ReasonCode, PassIncompleteReason));
        // `OrderByDescending` is stable, so the first row that gave the winning count wins the tie.
        return counted
            .GroupBy(code => code, StringComparer.Ordinal)
            .Select(group => (Code: group.Key, Count: group.Count()))
            .OrderByDescending(entry => entry.Count)
            .ToList();
    }

    /// <summary>
    /// The counts a FAILED pass answers with, per reason, in the hint.
    ///
    /// <para>
    /// A failed node carries no evidence - `Evidence` is what licenses `succeeded` (ADR-006) - so the row table this pass
    /// built would be dropped on exactly the answer a reader most needs it for. The hint is the short field a failed node
    /// does carry, and it is a COUNT, not a claim: "the pass refused every row for one reason" and "one row of sixty
    /// refused" must not arrive as the same bare code.
    /// </para>
    /// <para>
    /// The reasons come from <see cref="ReasonsByCount"/>, the same enumeration <see cref="DominantReason"/> reads, so the
    /// code in `FailureCode` is always one of the counts here. The budget is enforced AT THE PRODUCER
    /// (<see cref="BodyProgramValidation.MaximumNodeHintLength"/>): the journal refuses a longer hint, and a node refused
    /// there would answer `InvalidInput` instead of the reason it was given.
    /// </para>
    /// </summary>
    private static string FailureHint(FarmhandForEachPassResult pass) =>
        PassCounts(pass, BodyProgramValidation.MaximumNodeHintLength);

    /// <summary>
    /// The same counts, in the field a reader reads as `reasonDetail`.
    ///
    /// Measured 2026-11-10 (`round42`, day 6): the loop's hint carried `decided=9;succeeded=0;failed=1;refused=8;...` and the
    /// detail said `unknown_reason:failed`, because a failed node's evidence is dropped (ADR-006) and this aggregate never
    /// filled the one free-text field a failure MAY carry. The detail is a wider budget than the hint and the same text, so
    /// a reader sees the counts where it looks for the reason and the two fields cannot disagree.
    /// </summary>
    private static string FailureDetail(FarmhandForEachPassResult pass) =>
        PassCounts(pass, BodyProgramValidation.MaximumNodeRefusalDetailLength);

    /// <summary>
    /// The pass's counts, and then one `;code=count` per reason, as far as <paramref name="budget"/> allows.
    ///
    /// ONE producer for the two fields that carry them (`hint` and `reasonDetail`): two builders over the same numbers would
    /// eventually disagree about which reason is dominant, and a reader could not tell which one the pass decided with.
    /// </summary>
    private static string PassCounts(FarmhandForEachPassResult pass, int budget)
    {
        var counts = new StringBuilder(128);
        counts.Append(CultureInfo.InvariantCulture,
            $"decided={pass.Decided};succeeded={pass.Succeeded};failed={pass.Failed};refused={pass.Refused};not_matched={pass.NotMatched};left_alone={pass.LeftAlone};deferred={pass.Deferred};stopped={pass.StopObserved};omitted={pass.Omitted}");
        // A pass of chains says how many native effects it made, so a reader can see that one pass did the work four used to.
        if (pass.Steps > pass.Decided) counts.Append(CultureInfo.InvariantCulture, $";steps={pass.Steps}");
        foreach ((string code, int count) in ReasonsByCount(pass))
        {
            string entry = string.Create(CultureInfo.InvariantCulture, $";{code}={count}");
            if (counts.Length + entry.Length > budget) break;
            counts.Append(entry);
        }
        return counts.ToString();
    }

    /// <summary>
    /// One row's reason code, projected onto the grammar a node's `FailureCode` must satisfy (`BodyProgramValidation.IsReasonCode`:
    /// lowercase, digits, `_`, `:`, `-`).
    ///
    /// A row may name a tile (`no_rule_matched:rock@60,18`) or an action argument in its own camelCase
    /// (`row_argument_missing:expectedTargetId`). Neither is legal in a node's reason code, so the row's spelling is
    /// projected - the row table keeps it verbatim - and the projection is stated here rather than at each call site.
    /// </summary>
    private static string WireReason(string? reasonCode, string fallback)
    {
        if (reasonCode is null) return fallback;
        var projected = new StringBuilder(Math.Min(reasonCode.Length, 128));
        foreach (char character in reasonCode)
        {
            if (projected.Length >= 128) break;
            char lowered = char.ToLowerInvariant(character);
            projected.Append(lowered is >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or ':' or '-' ? lowered : '_');
        }
        return projected.Length == 0 ? fallback : projected.ToString();
    }

    private static string? LastReceiptId(FarmhandForEachPassResult pass) =>
        pass.Targets.LastOrDefault(target => target.ExecutionId is { Length: > 0 })?.ExecutionId;

    private const string ForEachWorldUnavailable = "for_each_world_unavailable";

    /// <summary>A rectangle whose rows the live world did not yield: nothing was decided, so nothing can be claimed.</summary>
    private const string NoRowsReason = "for_each_no_rows";

    private const string ForEachStoppedReason = "for_each_stopped";

    private const string NotOnFarmState = "not_on_farm";

    private const string TileOutsideFarmReason = "tile_outside_farm_map";

    /// <summary>The one wire argument this pass MINTS per row, and the one a caller may never declare.</summary>
    private const string ExpectedTargetIdArgument = "expectedTargetId";

    /// <summary>What the identity refusal names when the action declares no target family at all.</summary>
    private const string NoTargetFamily = "none";

    /// <summary>
    /// The refusal a family the pass has never examined answers - the unexamined gap, never a verdict about the family.
    /// `FarmhandForEachFamilyDriftTests` fails on that family by name, so the gap is closed where the population is derived
    /// rather than per refused row.
    /// </summary>
    private const string IdentityUnavailableRefusal = "row_target_identity_unavailable";

    private const string PassIncompleteReason = "for_each_pass_incomplete";

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
/// <summary>
/// What one pass's counts decide about the node, as a closed set.
///
/// <para>
/// A separate type rather than five `if` arms inside <c>ExecuteForEach</c> because the DECISION is the contract a caller
/// (and a gate) needs to ask directly: the arms used to be ordered statements, so "one refused row failed sixty worked
/// ones" was not a thing anyone could see without running a pass. The population of this enum is every answer a pass can
/// reach, and <see cref="RouteReenteringBodyProgramExecutor.VerdictFor"/> is the only producer.
/// </para>
/// </summary>
internal enum ForEachPassVerdict
{
    /// <summary>The native body still owns the embodied actor; a later tick re-enters the same pass.</summary>
    Continue = 1,

    /// <summary>STOP arrived between two rows. The rows it settled keep their receipts; the node is cancelled.</summary>
    Cancelled = 2,

    /// <summary>The source yielded no live row, so nothing was decided and nothing is claimed.</summary>
    NoRows = 3,

    /// <summary>Not one row did its thing. The pass did nothing, and says so with the dominant row reason.</summary>
    Failed = 4,

    /// <summary>Some rows did their thing and some did not: the honest middle, with proof and reason on one node.</summary>
    PartiallySucceeded = 5,

    /// <summary>Every row that was not deliberately left alone did its thing and proved it.</summary>
    Succeeded = 6,
}
