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
    IReadOnlyDictionary<string, FarmhandForEachValue> Fields,
    string? TargetId = null);

/// <summary>
/// One decided target, on its way to the Mod's single dispatch table.
///
/// <see cref="Arguments"/> is the loop's own `do` arguments as the caller declared them (scalars only), plus the row's
/// own coordinates and identity where the action needs them. Lifting those scalars into that action's DECLARED wire
/// arguments needs the action catalog, which is the dispatcher's business and not this pass's: a pass that guessed a
/// mapping would be a second action vocabulary beside the catalog.
/// </summary>
public sealed record FarmhandForEachTarget(
    string ActionId,
    int? X,
    int? Y,
    string? TargetId,
    IReadOnlyDictionary<string, string>? Arguments);

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

/// <summary>One row of a pass, with its own receipt when it produced one.</summary>
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
    string? Evidence)
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
    public static FarmhandForEachPassResult Expand(
        FarmhandForEachLoop loop,
        string requestId,
        IEnumerable<FarmhandForEachRow> rows,
        FarmhandForEachDispatch dispatch,
        Func<bool> stopRequested)
    {
        ArgumentNullException.ThrowIfNull(loop);
        ArgumentNullException.ThrowIfNull(rows);
        ArgumentNullException.ThrowIfNull(dispatch);
        ArgumentNullException.ThrowIfNull(stopRequested);
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
            var target = new FarmhandForEachTarget(effect.Action, row.X, row.Y, row.TargetId, effect.Arguments);
            string rowRequestId = RowIdentity(prefix, row, "req");
            string rowExecutionId = RowIdentity(prefix, row, "exec");
            FarmhandForEachTargetResult result = DispatchOne(target, row, rowRequestId, rowExecutionId, dispatch);
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
