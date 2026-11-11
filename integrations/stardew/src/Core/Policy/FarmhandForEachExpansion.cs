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
/// <see cref="FarmhandForEachStep.ByKindAction"/>: the classifier beside the row reader is the only thing that can say
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
/// One step of a row's chain, in the words every answer already uses: its position in the chain, the action it was, and
/// what became of it.
///
/// <see cref="Step"/> is the position the caller WROTE (`0` is the first step), so a row's `stopped_at` and this list
/// name the same step for the same row.
/// </summary>
public sealed record FarmhandForEachStepResult(int Step, string ActionId, FarmhandForEachTargetOutcome Outcome, string? ReasonCode);

/// <summary>
/// One row of a pass, with its own receipt when it produced one.
///
/// <para>
/// <see cref="Healed"/> is the one word this record adds to the receipt, and it is set only on a row the pass opened
/// first: <c>healed=&lt;occupant&gt;:&lt;clearingAction&gt;</c>, in the catalogue's own names for both halves. The row's
/// <see cref="Outcome"/> and <see cref="ReasonCode"/> are then the REQUESTED action's, because the clearing swing is a
/// means and not the answer - a reader asking "was the tile tilled" must not be told "a weed was cut".
/// </para>
/// <para>
/// <see cref="Steps"/> is every step the row took, in the order it took them - one shape whether the row's `do` was a
/// single action or a chain, so a reader never has to ask which form it is looking at. <see cref="StoppedAt"/> is set only
/// on a CHAIN that stopped before its last step (<c>&lt;step&gt;:&lt;reasonCode&gt;</c>): a one-action row already says
/// `refused`/`failed`/`stopped`, and repeating that as a position would be a second spelling of the same fact.
/// </para>
/// <para>
/// <see cref="Detail"/> IS THE ONE WORDS FIELD on a row, and it exists because a reason CODE is not an explanation: a tile
/// refused for her own grass answers <c>no_safe_clear:grass:cut_grass</c>, which names the decision that was withheld and
/// nothing about what taking it would cost. The sentence comes from the clearing declaration itself
/// (<see cref="FarmhandClearingDeclaration.RefusalDetail"/>) and the row hands it to the wire unchanged.
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
    string? Healed = null,
    IReadOnlyList<FarmhandForEachStepResult>? Steps = null,
    string? StoppedAt = null,
    string? Detail = null)
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

    /// <summary>
    /// How many native effects the pass performed, derived from the rows like every other count here.
    ///
    /// A one-action pass answers <c>Steps == Decided</c>; a pass of chains answers more, and that is the number a reader
    /// needs to see that one pass did what four passes used to.
    /// </summary>
    public int Steps => this.Targets.Sum(target => target.Steps?.Count ?? 0);

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

    /// <summary>Why a chain that stopped early but whose stopping step named nothing is reported: silence is not a reason.</summary>
    private const string StepStoppedWithoutReason = "step_stopped_without_reason";

    /// <summary>The word a row the pass never reached carries when STOP is what stopped it.</summary>
    private const string StoppedReason = "stopped";

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
    /// <param name="settled">
    /// The receipt the ledger already holds for one row identity, or null when it holds none. A pass re-entered after an
    /// unsettled receipt reads the world AGAIN, and this is what keeps the rows it already worked out of `not_matched`:
    /// a tile whose weed this pass just cut no longer satisfies `occupant: weed`, so without the receipt the pass would
    /// report its own work as a row nobody claimed.
    /// </param>
    public static FarmhandForEachPassResult Expand(
        FarmhandForEachLoop loop,
        string requestId,
        IEnumerable<FarmhandForEachRow> rows,
        FarmhandForEachDispatch dispatch,
        Func<bool> stopRequested,
        Func<string, bool> isActionEnabled,
        Func<string, LocalExecutionReceipt?> settled)
    {
        ArgumentNullException.ThrowIfNull(loop);
        ArgumentNullException.ThrowIfNull(rows);
        ArgumentNullException.ThrowIfNull(dispatch);
        ArgumentNullException.ThrowIfNull(stopRequested);
        ArgumentNullException.ThrowIfNull(isActionEnabled);
        ArgumentNullException.ThrowIfNull(settled);
        if (!loop.IsValid) throw new ArgumentException("The loop is not one this product can run.", nameof(loop));
        if (string.IsNullOrWhiteSpace(requestId)) throw new ArgumentException("A pass needs a request identity.", nameof(requestId));

        string prefix = requestId.Length > RowIdentityPrefixLength ? requestId[..RowIdentityPrefixLength] : requestId;
        var targets = new List<FarmhandForEachTargetResult>();
        var unmatched = new List<string>();
        bool anyMatched = false;
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
                // A ROW THE PASS ALREADY WORKED IS NOT A ROW NOBODY CLAIMED. The predicate is read against the world as
                // it is NOW, and the pass's own effects move that world: measured `round45`, seven `cut_weeds` rows were
                // cut and the pass that cut them reported `succeeded=0;not_matched=48` because every tile it had opened
                // stopped satisfying `occupant: weed` before the re-entered pass read it.
                FarmhandForEachTargetResult? worked = Worked(row, prefix, settled);
                if (worked is not null)
                {
                    targets.Add(worked);
                    // A receipt that has not settled still owns the actor, so the rest of the pass defers exactly as it
                    // would after a dispatched row: "was worked" and "settled" are two facts.
                    if (worked.Outcome == FarmhandForEachTargetOutcome.Deferred) actorBusy = true;
                    continue;
                }
                unmatched.Add(FarmhandForEachHealing.OccupantOf(row.Fields));
                targets.Add(Skipped(row, FarmhandForEachTargetOutcome.NotMatched, FarmhandForEachRules.NoRuleMatchedReasonCode(KindOf(row), row.X ?? -1, row.Y ?? -1)));
                continue;
            }
            anyMatched = true;
            if (effect is null)
            {
                targets.Add(Skipped(row, FarmhandForEachTargetOutcome.LeftAlone, null));
                continue;
            }
            // STOP is consulted HERE - between two native effects - and never while one is running.
            if (stopRequested())
            {
                stopped = true;
                targets.Add(Skipped(row, FarmhandForEachTargetOutcome.Stopped, StoppedReason));
                continue;
            }
            FarmhandForEachTargetResult result = DispatchChain(row, effect, prefix, isActionEnabled, dispatch, stopRequested, ref stopped);
            targets.Add(result);
            if (result.Outcome == FarmhandForEachTargetOutcome.Deferred) actorBusy = true;
        }
        // A PASS THAT CLAIMED NOTHING SAYS SO ONCE. One code per tile is not a statement about a patch: measured
        // `round45`, a 48-tile pass answered forty-eight `no_rule_matched:<kind>@<x>,<y>` entries and no caller can act on
        // forty-eight tiles. The one code names the test and what the tiles actually carried. Only a rule WITH predicates
        // can miss - a rule that has none claims every row - so the missing list is the test that had to claim these.
        if (!anyMatched && unmatched.Count > 0 && loop.Where is { } missed)
        {
            string reason = FarmhandForEachRules.NoRowMatchedWhereReasonCode(missed, unmatched);
            for (int index = 0; index < targets.Count; index += 1)
                if (targets[index].Outcome == FarmhandForEachTargetOutcome.NotMatched)
                    targets[index] = targets[index] with { ReasonCode = reason };
        }
        return new FarmhandForEachPassResult(targets.AsReadOnly(), omitted, stopped);
    }

    /// <summary>
    /// ONE ROW'S CHAIN: the steps in the order the caller wrote them, on one tile, in one pass.
    ///
    /// <para>
    /// EVERY STEP IS ITS OWN DISPATCH, through the same table a single action uses. The next step sees what the last one
    /// did, because the seam reads the live world on the game thread - so a step's preconditions are the action's OWN, and
    /// this pass keeps no second table of them. A step that is not `Succeeded` ENDS THE CHAIN at that step: nothing is
    /// rolled back (the world does not roll back a swing), and nothing after it is tried on a tile the previous step did
    /// not prepare.
    /// </para>
    /// <para>
    /// A BLOCKED STEP IS THE HEAL'S CASE, UNCHANGED: the existing one-clear-one-retry opens the tile for THAT step alone,
    /// and a clear the catalogue marks destructive is refused as `no_safe_clear` and stops the chain on the same line. The
    /// chain adds no second clearing policy of its own.
    /// </para>
    /// <para>
    /// `Deferred` IS NOT A STOP. A receipt that has not settled leaves the actor owned by the native body, so the chain (and
    /// then the pass) ends and a later pass re-enters - and the identities are per row AND per step, so the steps that
    /// already settled replay instead of running twice.
    /// </para>
    /// </summary>
    private static FarmhandForEachTargetResult DispatchChain(
        FarmhandForEachRow row,
        FarmhandForEachEffect effect,
        string prefix,
        Func<string, bool> isActionEnabled,
        FarmhandForEachDispatch dispatch,
        Func<bool> stopRequested,
        ref bool stopped)
    {
        bool chained = effect.Steps.Length > 1;
        var steps = new List<FarmhandForEachStepResult>(effect.Steps.Length);
        FarmhandForEachTargetResult? last = null;
        for (int index = 0; index < effect.Steps.Length; index++)
        {
            FarmhandForEachStep step = effect.Steps[index];
            // STOP lands between two effects of ONE row exactly as it does between two rows: the step in flight finishes,
            // the next one does not start, and the steps that ran keep their receipts.
            if (index > 0 && stopRequested())
            {
                stopped = true;
                return Finish(Skipped(row, FarmhandForEachTargetOutcome.Stopped, StoppedReason), steps, ChainStoppedAt(chained, index, StoppedReason));
            }
            var target = new FarmhandForEachTarget(step.Action, row.X, row.Y, step.Arguments, KindOf(row));
            FarmhandForEachTargetResult stepResult = DispatchOne(
                target,
                row,
                RowIdentity(prefix, row, index, "req"),
                RowIdentity(prefix, row, index, "exec"),
                dispatch);
            // A ROW THE TILE REFUSED IS A TILE THE PASS HAS NOT FINISHED WITH. `Refused` is the pass's own pre-dispatch
            // refusal and `Rejected` is the same fact one layer down - the action's admission declined before any native
            // effect. Nothing else is healed: a `Failed` step ran and may have written, an `Uncertain` one may have, and a
            // `Cancelled`/`Invalidated` one was stopped - retrying past any of those would apply a side effect twice.
            if (stepResult.Outcome == FarmhandForEachTargetOutcome.Refused
                || (stepResult.Outcome == FarmhandForEachTargetOutcome.Failed && stepResult.State == ExecutionState.Rejected))
                stepResult = Heal(row, target, prefix, index, stepResult, isActionEnabled, dispatch, stopRequested, ref stopped);
            steps.Add(new FarmhandForEachStepResult(index, target.ActionId, stepResult.Outcome, stepResult.ReasonCode));
            last = stepResult;
            if (stepResult.Outcome == FarmhandForEachTargetOutcome.Succeeded) continue;
            // THE CHAIN STOPS WHERE IT STOPPED. A `Deferred` step is the one that carries no `stopped_at`: the actor is busy
            // and a later pass continues, which is not the same fact as "this tile stopped being worked".
            return Finish(
                stepResult,
                steps,
                stepResult.Outcome == FarmhandForEachTargetOutcome.Deferred ? null : ChainStoppedAt(chained, index, stepResult.ReasonCode));
        }
        return Finish(last!, steps, null);
    }

    /// <summary>One row's answer with the steps it took, and the step it stopped at when it stopped early.</summary>
    private static FarmhandForEachTargetResult Finish(
        FarmhandForEachTargetResult row,
        IReadOnlyList<FarmhandForEachStepResult> steps,
        string? stoppedAt) =>
        row with { Steps = steps, StoppedAt = stoppedAt };

    /// <summary>
    /// Where a chain stopped, in the row's own receipt: <c>&lt;step&gt;:&lt;reasonCode&gt;</c>.
    ///
    /// A ONE-ACTION ROW HAS NONE: `refused`, `failed` and `stopped` already say what happened to it, and a position would be
    /// a second spelling of the same fact. This word exists for the row that took the first of several steps and not the
    /// rest, which is the one shape the counts alone cannot describe.
    /// </summary>
    private static string? ChainStoppedAt(bool chained, int step, string? reasonCode) =>
        chained ? string.Create(CultureInfo.InvariantCulture, $"{step}:{Blank(reasonCode) ?? StepStoppedWithoutReason}") : null;

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
    /// <para>
    /// A CLEAR THAT WOULD DESTROY SOMETHING SHE PUT ON THE TILE IS NOT TAKEN. When every published clearer of the occupant
    /// is destructive (`scythe_crop` on her own crop, `cut_grass` on grass a starter planted) the row reports the
    /// clearance's own refusal - `no_safe_clear:<occupant>:<action>` - as a REFUSED row with no swing made: the pass may
    /// not spend a destructive effect on a tile neither she nor the player asked it to clear. The row carries the
    /// declaration's own sentence beside that code, because "a swing was withheld" is not the same answer as "here is what
    /// the swing would have cost you, and it is yours to make".
    /// </para>
    /// </summary>
    private static FarmhandForEachTargetResult Heal(
        FarmhandForEachRow row,
        FarmhandForEachTarget target,
        string prefix,
        int step,
        FarmhandForEachTargetResult refused,
        Func<string, bool> isActionEnabled,
        FarmhandForEachDispatch dispatch,
        Func<bool> stopRequested,
        ref bool stopped)
    {
        FarmhandForEachClearance clearance = FarmhandForEachHealing.ClearanceFor(row.Fields, target.ActionId, isActionEnabled);
        if (clearance.Outcome == FarmhandForEachClearanceOutcome.KeepRefusal) return refused;
        if (clearance.Outcome is FarmhandForEachClearanceOutcome.NoPublishedActionClears or FarmhandForEachClearanceOutcome.NoSafeClear)
            return Result(
                row,
                target,
                FarmhandForEachTargetOutcome.Refused,
                refused.ExecutionId,
                refused.State,
                clearance.RefusalReasonCode,
                refused.Evidence,
                clearance.RefusalDetail);

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
            RowIdentity(prefix, row, step, "clear"),
            RowIdentity(prefix, row, step, "clear-exec"),
            dispatch);
        if (cleared.Outcome != FarmhandForEachTargetOutcome.Succeeded) return cleared;

        FarmhandForEachTargetResult retried = DispatchOne(
            target,
            row,
            RowIdentity(prefix, row, step, "req-retry"),
            RowIdentity(prefix, row, step, "exec-retry"),
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
        string? evidence,
        string? detail = null) =>
        new(row.X, row.Y, row.LocalColumn, row.LocalRow, outcome, target, executionId, state, reasonCode, evidence, Detail: detail);

    private static FarmhandForEachTargetResult Skipped(FarmhandForEachRow row, FarmhandForEachTargetOutcome outcome, string? reasonCode) =>
        new(row.X, row.Y, row.LocalColumn, row.LocalRow, outcome, null, null, null, reasonCode, null);

    /// <summary>Why a row the pass never reached carries a reason: "stopped" and "the actor is busy" are not the same.</summary>
    private static string? ReasonOf(FarmhandForEachRow row, bool stopped) =>
        stopped ? "stopped" : DeferredReason(row);

    private static string DeferredReason(FarmhandForEachRow row) =>
        string.Create(CultureInfo.InvariantCulture, $"actor_busy:row{row.LocalRow}c{row.LocalColumn}");

    /// <summary>
    /// A row the rules no longer claim, answered from the receipts THIS pass already recorded for it.
    ///
    /// <para>
    /// WHY THIS EXISTS. A row is decided against the world as it is NOW, and the pass's own effects move that world: a
    /// `cut_weeds`/`break_rock` row removes the thing its predicate asked for. `cut_weeds` also walks the actor in, so its
    /// first dispatch answers with a receipt that has not settled, the pass ends `deferred`, and the node re-enters - at
    /// which point every tile it just opened fails `occupant: weed` and the row is reported as one nobody claimed.
    /// Measured `round45` (`plan_66_dc0f5736a9faf977`): seven weeds cut, `decided=48;succeeded=0;failed=0;refused=0;
    /// not_matched=48`, node `failed`. The ledger is the record of that work; this reads it instead of re-deriving the row
    /// from a world the row itself changed.
    /// </para>
    /// <para>
    /// THE IDENTITY IS THE ONE THIS PASS MINTS, so there is no second row model: <see cref="RowIdentity"/> is asked for the
    /// steps a chain may take, from the LAST backwards (a chain stops at its first non-success, so the highest settled step
    /// is the row's answer), and for the retry before the attempt it retried (a healed row's answer is the retry's).
    /// </para>
    /// <para>
    /// A RECEIPT THAT HAS NOT SETTLED IS STILL THE ROW'S. It is reported `deferred`, exactly as the dispatched row was -
    /// what changes between two re-entries is the receipt's state, never whether the row was worked.
    /// </para>
    /// </summary>
    private static FarmhandForEachTargetResult? Worked(
        FarmhandForEachRow row,
        string prefix,
        Func<string, LocalExecutionReceipt?> settled)
    {
        for (int step = FarmhandForEachEffect.MaximumSteps - 1; step >= 0; step -= 1)
            foreach (string kind in ReceiptKinds)
            {
                if (settled(RowIdentity(prefix, row, step, kind)) is not { } receipt) continue;
                FarmhandForEachTargetOutcome outcome =
                    receipt.State == ExecutionState.Succeeded ? FarmhandForEachTargetOutcome.Succeeded
                    : receipt.State.IsTerminal() ? FarmhandForEachTargetOutcome.Failed
                    : FarmhandForEachTargetOutcome.Deferred;
                return new FarmhandForEachTargetResult(
                    row.X,
                    row.Y,
                    row.LocalColumn,
                    row.LocalRow,
                    outcome,
                    receipt.ActionId is { Length: > 0 } actionId ? new FarmhandForEachTarget(actionId, row.X, row.Y, null) : null,
                    receipt.ExecutionId,
                    receipt.State,
                    receipt.ReasonCode,
                    receipt.Evidence);
            }
        return null;
    }

    /// <summary>
    /// The two identities one step of a row can settle under: the retry a heal minted, and the attempt before it.
    ///
    /// Retry first, because a retry exists only where the row was opened and re-attempted, and the retry IS the row's
    /// answer (`FarmhandForEachHealing` says the clearing swing is a means, not the answer).
    /// </summary>
    private static readonly string[] ReceiptKinds = { "req-retry", "req" };

    /// <summary>
    /// The row's own dispatch identity, derived from the pass's and not from a counter.
    ///
    /// Deterministic on purpose: re-entering the pass after a STOP, a deferral or a reconnect mints the SAME identity for
    /// the same row AND the same step, so the router answers with the receipt it already recorded instead of running the
    /// effect twice - and so <see cref="Worked"/> can ask the ledger about a row the predicates no longer claim.
    ///
    /// THE FIRST STEP KEEPS THE IDENTITY A SINGLE-ACTION LOOP ALREADY GIVES ITS ROW, unsuffixed. A journal holds that
    /// spelling for a row it dispatched before chains existed, and renaming the row's own first step would replay it as a
    /// new effect on a tile the world has already moved on.
    /// </summary>
    private static string RowIdentity(string prefix, FarmhandForEachRow row, int step, string kind)
    {
        // The first step is unsuffixed, so a row and its first step share the identity a single-action loop already mints.
        string suffix = step == 0 ? string.Empty : step.ToString(CultureInfo.InvariantCulture);
        return string.Create(CultureInfo.InvariantCulture, $"{prefix}-{kind}{suffix}-r{row.LocalRow}c{row.LocalColumn}");
    }

    /// <summary>The row's own word for what it is, which is what `no_rule_matched` must name.</summary>
    private static string KindOf(FarmhandForEachRow row) =>
        row.Fields.TryGetValue("kind", out FarmhandForEachValue? kind) && kind?.Text is { Length: > 0 } text
            ? text
            : "unknown";

    private static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
