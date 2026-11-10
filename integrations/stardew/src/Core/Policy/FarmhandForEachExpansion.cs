using System.Globalization;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// One live row the loop's source yielded, as the world reports it NOW.
///
/// The caller supplies the row; this pass never reads the world and never trusts the snapshot the plan was written
/// from. `LocalColumn`/`LocalRow` are the row's position INSIDE the source (0-based, in the source's own order), which is
/// what a position guard tests; `X`/`Y` are the map tile, absent for the thirteen published families whose rows carry no
/// tile.
/// </summary>
public sealed record FarmhandForEachRow(
    int? X,
    int? Y,
    int LocalColumn,
    int LocalRow,
    IReadOnlyDictionary<string, FarmhandForEachValue> Fields);

/// <summary>One decided target, on its way to the Mod's single dispatch table.</summary>
///
/// <para>
/// <see cref="Arguments"/> is the loop's own `do` arguments as the caller declared them (scalars only), plus the row's
/// own coordinates where the action needs them. Lifting those scalars into that action's DECLARED wire arguments needs
/// the action catalog, which is the dispatcher's business and not this pass's: a pass that guessed a mapping would be a
/// second action vocabulary beside the catalog.
/// </para>
/// <para>
/// THE TARGET IDENTITY IS NOT A FIELD HERE, and that is a fact about the form rather than an omission. Which family mints
/// the identity is decided by the ACTION (<c>FarmhandActionDescriptor.TargetFamily</c>), and the action is not known when
/// the row is read - `by_kind` resolves only at dispatch - so the identity is minted where both the action and the live
/// tile are known: <c>RouteReenteringBodyProgramExecutor.TryBuildRowArguments</c>, from the world. A field here would be
/// null on every row and would read as an identity somebody forgot to fill.
/// </para>
/// <para>
/// <see cref="Kind"/> is the row's OWN word for what stands there, carried for the one caller that must answer
/// <see cref="FarmhandForEachEffect.ByKindAction"/>: the classifier beside the row reader is the only thing that can say
/// which action clears a kind, and it needs the kind to say it.
/// </para>
public sealed record FarmhandForEachTarget(
    string ActionId,
    int? X,
    int? Y,
    IReadOnlyDictionary<string, string>? Arguments,
    string? Kind = null);

/// <summary>What became of one row of a pass.</summary>
public enum FarmhandForEachTargetOutcome
{
    /// <summary>The dispatch ran and its receipt settled successfully.</summary>
    Succeeded = 1,

    /// <summary>The dispatch ran and its receipt settled otherwise; <c>ReasonCode</c> is the engine's own.</summary>
    Failed = 2,

    /// <summary>The dispatch ran and the receipt has NOT settled (accepted/running): the actor is busy and a later pass continues.</summary>
    Deferred = 3,

    /// <summary>The dispatch itself was refused before any native effect, or threw. <c>ReasonCode</c> names why.</summary>
    Refused = 4,

    /// <summary>A rule matched and said `do: null`: a deliberate path, not a forgotten row.</summary>
    LeftAlone = 5,

    /// <summary>NO rule matched. Reported, never skipped: a skipped row reads as a cleared patch.</summary>
    NotMatched = 6,

    /// <summary>The pass stopped before reaching this row, because STOP arrived between two native effects.</summary>
    Stopped = 7,
}

/// <summary>
/// One row of a pass, with its own receipt when it produced one.
///
/// <para>
/// <see cref="Healed"/> is the one word this record adds to the receipt, and it is set only on a row the pass opened
/// first: <c>healed=&lt;occupant&gt;:&lt;clearingAction&gt;</c>, in the catalogue's own names for both halves. The row's
/// <see cref="Outcome"/> and <see cref="ReasonCode"/> are then the REQUESTED action's, because the clearing swing is a
/// means and not the answer - a reader asking "was the tile tilled" must not be told "a weed was cut".
/// </para>
/// </summary>
public sealed record FarmhandForEachTargetResult(
    int? X,
    int? Y,
    int LocalColumn,
    int LocalRow,
    FarmhandForEachTargetOutcome Outcome,
    FarmhandForEachTarget? Target,
    string? ExecutionId,
    ExecutionState? State,
    string? ReasonCode,
    string? Evidence,
    string? Healed = null)
{
    /// <summary>Where the target is, in the one shape every answer uses - or null when the row carries no tile.</summary>
    public string? Tile => this.X is null || this.Y is null
        ? null
        : string.Create(CultureInfo.InvariantCulture, $"{this.X},{this.Y}");
}

/// <summary>
/// What one pass did, and the counts a reader needs so no number has to be re-derived from the rows.
///
/// The counts are DERIVED from <see cref="Targets"/> rather than stored beside it: two copies of "how many succeeded"
/// would eventually disagree, and the reader could not tell which one the pass decided with.
/// </summary>
public sealed record FarmhandForEachPassResult(
    IReadOnlyList<FarmhandForEachTargetResult> Targets,
    int Omitted,
    bool Stopped)
{
    public int Decided => this.Targets.Count;

    public int Succeeded => this.Count(FarmhandForEachTargetOutcome.Succeeded);

    public int Failed => this.Count(FarmhandForEachTargetOutcome.Failed);

    public int Deferred => this.Count(FarmhandForEachTargetOutcome.Deferred);

    public int Refused => this.Count(FarmhandForEachTargetOutcome.Refused);

    public int LeftAlone => this.Count(FarmhandForEachTargetOutcome.LeftAlone);

    public int NotMatched => this.Count(FarmhandForEachTargetOutcome.NotMatched);

    public int StopObserved => this.Count(FarmhandForEachTargetOutcome.Stopped);

    /// <summary>How many rows the pass opened before working them, derived from the rows like every other count here.</summary>
    public int Healed => this.Targets.Count(target => target.Healed is not null);

    private int Count(FarmhandForEachTargetOutcome outcome) =>
        this.Targets.Count(target => target.Outcome == outcome);
}

/// <summary>
/// The Mod's single dispatch table, in the shape this pass needs it: one target in, one receipt out.
///
/// The parameters are exactly the ones <c>FarmhandActionRouter.TryRoute(request, ledger, executionId, out receipt, out
/// reasonCode)</c> takes once the target's own arguments have been lifted into that action's declared wire arguments, so
/// the production binding is one lambda over the router and there is no second actionId to native mapping anywhere. The
/// request identity is minted HERE, per row, so re-entering the same pass replays the router's existing receipt instead
/// of running the native effect twice.
/// </summary>
public delegate bool FarmhandForEachDispatch(
    FarmhandForEachTarget target,
    string requestId,
    string executionId,
    out LocalExecutionReceipt receipt,
    out string reasonCode);

/// <summary>
/// The `for_each` expansion: one pass over the rows a source yields, deciding each row ONCE by the first rule that claims
/// it, and re-entering the Mod's own dispatch seam for every effect.
///
/// <para>
/// IT IS PURE ON PURPOSE. The caller supplies the loop, the live rows and the two delegates, so the decision order, the
/// receipts and the STOP boundary are testable without a game. The rows are read live: this never expands against the
/// snapshot the plan was written from, which is the whole reason the form exists - a 3x20 patch does not fit any
/// observation the Host ever sees.
/// </para>
/// <para>
/// STOP IS CHECKED BETWEEN TWO NATIVE EFFECTS AND NEVER INSIDE ONE. The delegate runs to completion, so a STOP that
/// arrives mid-effect cannot leave a half-applied action: the receipt says what that effect did, and the next row is the
/// first one marked <see cref="FarmhandForEachTargetOutcome.Stopped"/>.
/// </para>
/// <para>
/// A RECEIPT THAT HAS NOT SETTLED ENDS THE PASS. The native body still owns the actor, so dispatching the next target
/// would contend with it for the same embodied actor; it would also make "one winner per tile" depend on timing.
/// </para>
/// </summary>
public static class FarmhandForEachExpansion
{
    /// <summary>Why a dispatch the router refused is reported, when the router named nothing.</summary>
    public const string DispatchRefusedReason = "for_each_dispatch_refused";

    /// <summary>How many characters of the caller's request id a row's own id keeps, so the row id stays an identifier.</summary>
    private const int RowIdentityPrefixLength = 64;

    /// <summary>
    /// Expands one pass.
    /// </summary>
    /// <param name="loop">The loop, including any further rules of the same pass, in the caller's order.</param>
    /// <param name="requestId">The pass's own request identity; each row's identity is derived from it deterministically.</param>
    /// <param name="rows">The live rows the source yields, in the source's own order.</param>
    /// <param name="dispatch">The Mod's dispatch seam, once per decided target.</param>
    /// <param name="stopRequested">Whether STOP has arrived; consulted between two effects, never during one.</param>
    /// <param name="isActionEnabled">
    /// The live action policy, asked about a CLEARING action the caller never named. It is the same set the row itself is
    /// checked against, so a heal cannot reach an action the policy disables.
    /// </param>
    public static FarmhandForEachPassResult Expand(
        FarmhandForEachLoop loop,
        string requestId,
        IEnumerable<FarmhandForEachRow> rows,
        FarmhandForEachDispatch dispatch,
        Func<bool> stopRequested,
        Func<string, bool> isActionEnabled)
    {
        ArgumentNullException.ThrowIfNull(loop);
        ArgumentNullException.ThrowIfNull(rows);
        ArgumentNullException.ThrowIfNull(dispatch);
        ArgumentNullException.ThrowIfNull(stopRequested);
        ArgumentNullException.ThrowIfNull(isActionEnabled);
        if (!loop.IsValid) throw new ArgumentException("The loop is not one this product can run.", nameof(loop));
        if (string.IsNullOrWhiteSpace(requestId)) throw new ArgumentException("A pass needs a request identity.", nameof(requestId));

        string prefix = requestId.Length > RowIdentityPrefixLength ? requestId[..RowIdentityPrefixLength] : requestId;
        var targets = new List<FarmhandForEachTargetResult>();
        int decided = 0;
        int omitted = 0;
        bool stopped = false;
        bool actorBusy = false;
        foreach (FarmhandForEachRow row in rows)
        {
            ArgumentNullException.ThrowIfNull(row);
            ArgumentNullException.ThrowIfNull(row.Fields);
            // Over the per-intent bound the answer says how many rows it did NOT address. It never truncates the table
            // silently, because a shorter table reads as a finished pass over a smaller patch.
            if (decided >= FarmhandForEachSource.MaximumRows)
            {
                omitted += 1;
                continue;
            }
            decided += 1;
            if (stopped || actorBusy)
            {
                targets.Add(Skipped(row, stopped ? FarmhandForEachTargetOutcome.Stopped : FarmhandForEachTargetOutcome.Deferred, ReasonOf(row, stopped)));
                continue;
            }
            (bool matched, FarmhandForEachEffect? effect) = FarmhandForEachRules.DecideByRules(loop, row.Fields, row.LocalColumn, row.LocalRow);
            if (!matched)
            {
                targets.Add(Skipped(row, FarmhandForEachTargetOutcome.NotMatched, FarmhandForEachRules.NoRuleMatchedReasonCode(KindOf(row), row.X ?? -1, row.Y ?? -1)));
                continue;
            }
            if (effect is null)
            {
                targets.Add(Skipped(row, FarmhandForEachTargetOutcome.LeftAlone, null));
                continue;
            }
            // STOP is consulted HERE - between two native effects - and never while one is running.
            if (stopRequested())
            {
                stopped = true;
                targets.Add(Skipped(row, FarmhandForEachTargetOutcome.Stopped, "stopped"));
                continue;
            }
            var target = new FarmhandForEachTarget(effect.Action, row.X, row.Y, effect.Arguments, KindOf(row));
            string rowRequestId = RowIdentity(prefix, row, "req");
            string rowExecutionId = RowIdentity(prefix, row, "exec");
            FarmhandForEachTargetResult result = DispatchOne(target, row, rowRequestId, rowExecutionId, dispatch);
            // A ROW THE TILE REFUSED IS A TILE THE PASS HAS NOT FINISHED WITH. `Refused` is the pass's own pre-dispatch
            // refusal and `Rejected` is the same fact one layer down - the action's admission declined before any native
            // effect. Nothing else is healed: a `Failed` row ran and may have written, an `Uncertain` one may have, and a
            // `Cancelled`/`Invalidated` one was stopped - retrying past any of those would apply a side effect twice.
            if (result.Outcome == FarmhandForEachTargetOutcome.Refused
                || (result.Outcome == FarmhandForEachTargetOutcome.Failed && result.State == ExecutionState.Rejected))
                result = Heal(row, target, prefix, result, isActionEnabled, dispatch, stopRequested, ref stopped);
            targets.Add(result);
            if (result.Outcome == FarmhandForEachTargetOutcome.Deferred) actorBusy = true;
        }
        return new FarmhandForEachPassResult(targets.AsReadOnly(), omitted, stopped);
    }

    private static FarmhandForEachTargetResult DispatchOne(
        FarmhandForEachTarget target,
        FarmhandForEachRow row,
        string requestId,
        string executionId,
        FarmhandForEachDispatch dispatch)
    {
        // NOTHING IS CAUGHT HERE. The dispatch seam is the router, and the router already turns a handler that escaped
        // into a terminal `Uncertain` receipt named `handler_exception` - a second catcher here would name the same
        // incident twice, and with a word this file chose rather than the one the Mod recorded. A throw that reaches
        // this line therefore came from BEFORE any native effect and is a caller defect, not a world outcome.
        if (!dispatch(target, requestId, executionId, out LocalExecutionReceipt receipt, out string reasonCode))
            return Result(row, target, FarmhandForEachTargetOutcome.Refused, executionId, null, Blank(reasonCode) ?? DispatchRefusedReason, null);
        FarmhandForEachTargetOutcome outcome =
            receipt.State == ExecutionState.Succeeded ? FarmhandForEachTargetOutcome.Succeeded
            : receipt.State.IsTerminal() ? FarmhandForEachTargetOutcome.Failed
            : FarmhandForEachTargetOutcome.Deferred;
        return Result(row, target, outcome, receipt.ExecutionId, receipt.State, receipt.ReasonCode, receipt.Evidence);
    }

    /// <summary>
    /// One refused row's second chance: clear what stands on the tile with the action the CATALOGUE names for it, then
    /// retry the requested action on the same tile, in the same pass.
    ///
    /// <para>
    /// THE BOUND IS ONE CLEAR AND ONE RETRY. A tile that still refuses after a swing at the thing on it is reported as the
    /// refusal it is - clearing is not a search, and a pass that kept swinging would be spending the actor's stamina on a
    /// guess.
    /// </para>
    /// <para>
    /// THE CLEARING SWING IS A NATIVE EFFECT AND STOP IS CONSULTED BEFORE IT, not after: the row's requested action was
    /// refused without running, so this is the boundary the STOP lands on.
    /// </para>
    /// <para>
    /// A CLEAR THAT DID NOT HAPPEN IS THE ANSWER. Its own receipt (outcome, reason, evidence) is reported verbatim rather
    /// than being folded into the row's original refusal: the clearing action's admission is the thing that has to be fixed,
    /// and it names the tool or the argument it needs (`basic_scythe_not_equipped`, `row_argument_missing:slot`).
    /// </para>
    /// <para>
    /// THE RETRY MINTS ITS OWN IDENTITY because the row's first attempt already recorded a receipt against the row's own:
    /// the router replays by request id, so retrying under the same one would answer with the refusal it is retrying past.
    /// The identity is still derived from the row, so re-entering the pass replays the clear and the retry in the same order.
    /// </para>
    /// </summary>
    private static FarmhandForEachTargetResult Heal(
        FarmhandForEachRow row,
        FarmhandForEachTarget target,
        string prefix,
        FarmhandForEachTargetResult refused,
        Func<string, bool> isActionEnabled,
        FarmhandForEachDispatch dispatch,
        Func<bool> stopRequested,
        ref bool stopped)
    {
        FarmhandForEachClearance clearance = FarmhandForEachHealing.ClearanceFor(row.Fields, target.ActionId, isActionEnabled);
        if (clearance.Outcome == FarmhandForEachClearanceOutcome.KeepRefusal) return refused;
        if (clearance.Outcome == FarmhandForEachClearanceOutcome.NoPublishedActionClears)
            return Result(
                row,
                target,
                FarmhandForEachTargetOutcome.Refused,
                refused.ExecutionId,
                refused.State,
                clearance.RefusalReasonCode,
                refused.Evidence);

        FarmhandClearingOffer clearer = clearance.Clearer!;
        if (stopRequested())
        {
            stopped = true;
            return Skipped(row, FarmhandForEachTargetOutcome.Stopped, "stopped");
        }
        // THE CLEARING ACTION'S OWN ARGUMENTS ARE ITS OWN. The row's `do` scalars belong to the requested action, and
        // carrying them across would be the pass inventing a call nobody wrote; a clearer that declares an argument this
        // row cannot supply is refused by name (`row_argument_missing:<argument>`), which is the fact to report.
        var clearTarget = new FarmhandForEachTarget(clearer.ActionId, row.X, row.Y, null);
        FarmhandForEachTargetResult cleared = DispatchOne(
            clearTarget,
            row,
            RowIdentity(prefix, row, "clear"),
            RowIdentity(prefix, row, "clear-exec"),
            dispatch);
        if (cleared.Outcome != FarmhandForEachTargetOutcome.Succeeded) return cleared;

        FarmhandForEachTargetResult retried = DispatchOne(
            target,
            row,
            RowIdentity(prefix, row, "req-retry"),
            RowIdentity(prefix, row, "exec-retry"),
            dispatch);
        return retried with { Healed = FarmhandForEachHealing.HealedToken(clearance.Occupant, clearer.ActionId) };
    }

    private static FarmhandForEachTargetResult Result(
        FarmhandForEachRow row,
        FarmhandForEachTarget target,
        FarmhandForEachTargetOutcome outcome,
        string? executionId,
        ExecutionState? state,
        string? reasonCode,
        string? evidence) =>
        new(row.X, row.Y, row.LocalColumn, row.LocalRow, outcome, target, executionId, state, reasonCode, evidence);

    private static FarmhandForEachTargetResult Skipped(FarmhandForEachRow row, FarmhandForEachTargetOutcome outcome, string? reasonCode) =>
        new(row.X, row.Y, row.LocalColumn, row.LocalRow, outcome, null, null, null, reasonCode, null);

    /// <summary>Why a row the pass never reached carries a reason: "stopped" and "the actor is busy" are not the same.</summary>
    private static string? ReasonOf(FarmhandForEachRow row, bool stopped) =>
        stopped ? "stopped" : DeferredReason(row);

    private static string DeferredReason(FarmhandForEachRow row) =>
        string.Create(CultureInfo.InvariantCulture, $"actor_busy:row{row.LocalRow}c{row.LocalColumn}");

    /// <summary>
    /// The row's own dispatch identity, derived from the pass's and not from a counter.
    ///
    /// Deterministic on purpose: re-entering the pass after a STOP, a deferral or a reconnect mints the SAME identity for
    /// the same row, so the router answers with the receipt it already recorded instead of running the effect twice.
    /// </summary>
    private static string RowIdentity(string prefix, FarmhandForEachRow row, string kind) =>
        string.Create(CultureInfo.InvariantCulture, $"{prefix}-{kind}-r{row.LocalRow}c{row.LocalColumn}");

    /// <summary>The row's own word for what it is, which is what `no_rule_matched` must name.</summary>
    private static string KindOf(FarmhandForEachRow row) =>
        row.Fields.TryGetValue("kind", out FarmhandForEachValue? kind) && kind?.Text is { Length: > 0 } text
            ? text
            : "unknown";

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
