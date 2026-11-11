using System.Globalization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The `for_each` expansion: one pass over live rows, decided once per row by the first rule that claims it, through the
/// Mod's own dispatch table.
///
/// WHY THESE CASES EXIST BESIDE `FarmhandForEachRulesTests`. That file pins what one loop DECIDES. This one pins what a
/// pass DOES, and every case here is a place the honest answer is not the obvious one:
///
///  - a 3x20 intercropped patch is ONE intent with three rules, so no tile is decided twice and no tile is reported as
///    forgotten by the rule that does not own it;
///  - STOP is consulted between two native effects and never inside one, so an effect in flight always finishes;
///  - a receipt that has not settled ends the pass, because the native body still owns the embodied actor;
///  - a row the pass never reached is still REPORTED (as omitted, stopped or deferred), because a table shortened in
///    silence reads as a finished pass over a smaller patch.
///
/// The dispatch seam is the real `FarmhandActionRouter` with a real ledger and a stub handler: the pass must reach the
/// SAME table single-target dispatch uses, and a test that substituted its own table would prove nothing about that.
/// </summary>
public sealed class FarmhandForEachExpansionTests
{
    /// <summary>A ledger with the router's replay and identity-binding behaviour, in memory.</summary>
    private sealed class Ledger : IExecutionLedger, IDispatchExecutionLedger
    {
        private readonly Dictionary<string, LocalExecutionReceipt> receipts = new(StringComparer.Ordinal);
        private readonly Dictionary<string, string> boundExecutions = new(StringComparer.Ordinal);

        public long CurrentRevision { get; private set; } = 1;

        public bool IsBodyBusy { get; set; }

        public bool TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode)
        {
            if (this.boundExecutions.TryGetValue(requestId, out string? existing))
            {
                reasonCode = string.Equals(existing, executionId, StringComparison.Ordinal)
                    ? "execution_identity_already_bound"
                    : "execution_identity_conflict";
                return false;
            }
            this.boundExecutions[requestId] = executionId;
            reasonCode = "bound";
            return true;
        }

        public bool TryGetBoundExecutionId(string requestId, out string executionId)
        {
            if (this.boundExecutions.TryGetValue(requestId, out string? existing))
            {
                executionId = existing;
                return true;
            }
            executionId = string.Empty;
            return false;
        }

        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt)
        {
            if (this.receipts.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            {
                receipt = existing;
                return true;
            }
            receipt = default!;
            return false;
        }

        public void BindAction(string requestId, string actionId) { }

        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt)
        {
            this.receipts[receipt.RequestId] = receipt;
            return receipt;
        }

        public LocalExecutionReceipt RememberTerminal(
            string requestId,
            string executionId,
            ExecutionState state,
            string reasonCode,
            string? evidence,
            BridgeLocalObservation? observation = null)
        {
            this.CurrentRevision += 1;
            var receipt = new LocalExecutionReceipt(
                executionId,
                requestId,
                state,
                reasonCode,
                this.CurrentRevision,
                evidence,
                Observation: observation);
            this.receipts[requestId] = receipt;
            return receipt;
        }

        public void AddTrace(LocalExecutionReceipt receipt) { }
    }

    /// <summary>
    /// The stub native effect: it records every dispatch, then answers with the state the case asked for. It is the only
    /// place a case can observe "how many native effects ran", which is the number STOP and deferral are judged by.
    /// </summary>
    private sealed class RecordingHandler : IFarmhandActionHandler
    {
        private readonly ExecutionState state;
        private readonly string reasonCode;
        private readonly string? failureEvidence;

        public RecordingHandler(ExecutionState state = ExecutionState.Succeeded, string reasonCode = "test_succeeded", string? failureEvidence = null)
        {
            this.state = state;
            this.reasonCode = reasonCode;
            this.failureEvidence = failureEvidence;
        }

        public List<BridgeExecutionRequest> Requests { get; } = new();

        public List<string> ExecutionIds { get; } = new();

        public Action<BridgeExecutionRequest>? After { get; set; }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatch && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                ? bound
                : "exec_unbound";
            this.Requests.Add(request);
            this.ExecutionIds.Add(executionId);
            LocalExecutionReceipt receipt = ledger.RememberTerminal(
                request.RequestId,
                executionId,
                this.state,
                this.reasonCode,
                this.failureEvidence);
            this.After?.Invoke(request);
            return receipt;
        }
    }

    private sealed class ThrowingHandler : IFarmhandActionHandler
    {
        public int Calls { get; private set; }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            this.Calls += 1;
            throw new InvalidOperationException("native body blew up");
        }
    }

    private static Dictionary<string, FarmhandForEachValue> Row(string kind = "empty_tillable") =>
        new(StringComparer.Ordinal) { ["kind"] = FarmhandForEachValue.Of(kind) };

    private static FarmhandForEachPredicate Stride(string axis, int every, int offset) =>
        new(null, FarmhandForEachComparison.In, Array.Empty<FarmhandForEachValue>())
        {
            Axis = axis,
            Stride = new FarmhandForEachStride(every, offset),
        };

    private static FarmhandForEachSource Rect(int x, int y, int w, int h) =>
        new(FarmhandForEachSource.AreaKind, x, y, w, h);

    /// <summary>One live tile row, with the occupant the farm world publishes for it in the `Clears` vocabulary.</summary>
    private static FarmhandForEachRow Occupied(int x, int y, int localColumn, string occupant) =>
        new(x, y, localColumn, 0, new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
        {
            ["kind"] = FarmhandForEachValue.Of(occupant),
            [FarmhandForEachHealing.OccupantField] = FarmhandForEachValue.Of(occupant),
        });

    /// <summary>The live rows a rectangle source yields, exactly as the Mod reads them off the map.</summary>
    private static IEnumerable<FarmhandForEachRow> AreaRows(FarmhandForEachSource source) =>
        FarmhandForEachRules.AreaRows(source).Select(row => new FarmhandForEachRow(row.X, row.Y, row.LocalColumn, row.LocalRow, Row()));

    private static (FarmhandActionRouter Router, Ledger Ledger) Table(IFarmhandActionHandler handler, params string[] actionIds)
    {
        var router = new FarmhandActionRouter();
        var ledger = new Ledger();
        foreach (string actionId in actionIds)
            router.Register(
                new FarmhandActionRegistration(actionId, "test", 1, FarmhandActionLifecycle.Published, FarmhandOperationKind.Execution, FarmhandActionHandlerGroup.Farming),
                handler);
        return (router, ledger);
    }

    /// <summary>The production binding: the pass's delegate IS the router's own seam, one lambda wide.</summary>
    private static FarmhandForEachDispatch DispatchTo(FarmhandActionRouter router, Ledger ledger) =>
        (FarmhandForEachTarget target, string requestId, string executionId, out LocalExecutionReceipt receipt, out string reasonCode) =>
            router.TryRoute(
                new BridgeExecutionRequest(
                    requestId,
                    requestId,
                    target.ActionId,
                    new BridgeExecutionArgs { X = target.X, Y = target.Y },
                    0,
                    60_000),
                ledger,
                executionId,
                out receipt,
                out reasonCode);

    private static FarmhandForEachEffect Plant(string seed) =>
        new(new FarmhandForEachStep("plant_seed", new Dictionary<string, string>(StringComparer.Ordinal) { ["seed"] = seed }));

    /// <summary>
    /// THE INTERCROPPED PATCH, per tile, nothing coalesced: hops on columns 0, 3, 6..., coffee on 1, 4, 7..., path on
    /// 2, 5, 8... - three rules of ONE pass, so each of the 60 tiles is decided exactly once.
    /// </summary>
    [Fact]
    public void AnIntercroppedPatchIsOnePassAndEveryTileIsDecidedExactlyOnce()
    {
        FarmhandForEachSource patch = Rect(60, 18, 20, 3);
        var hops = new FarmhandForEachPredicate[] { Stride(FarmhandForEachPredicate.ColOperator, 3, 0) };
        var coffee = new FarmhandForEachPredicate[] { Stride(FarmhandForEachPredicate.ColOperator, 3, 1) };
        var path = new FarmhandForEachPredicate[] { Stride(FarmhandForEachPredicate.ColOperator, 3, 2) };
        var loop = new FarmhandForEachLoop(patch, hops, Plant("hops"), new[]
        {
            new FarmhandForEachRule(coffee, Plant("coffee")),
            new FarmhandForEachRule(path, null),
        });

        var handler = new RecordingHandler();
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "plant_seed");

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_1", AreaRows(patch), DispatchTo(router, ledger), () => false, _ => true, _ => null);

        pass.Decided.Should().Be(60, "20 columns by 3 rows is one intent and the measured patch");
        pass.Omitted.Should().Be(0);
        pass.Stopped.Should().BeFalse();
        pass.NotMatched.Should().Be(0, "every column of the patch is a deliberate decision");
        pass.LeftAlone.Should().Be(18, "columns 2, 5, 8 ... are a path, three per row");
        pass.Succeeded.Should().Be(42, "hops on 7 columns and coffee on 7, per row");
        pass.Refused.Should().Be(0);
        handler.Requests.Should().HaveCount(42, "a path column starts no native effect at all");

        // The seed each tile was given comes from the rule that claimed it, and it is asserted PER TILE.
        string[] firstRow = pass.Targets
            .Where(target => target.LocalRow == 0)
            .OrderBy(target => target.LocalColumn)
            .Select(target => target.Target switch
            {
                null => "path",
                FarmhandForEachTarget decided => decided.Arguments!["seed"],
            })
            .ToArray();
        firstRow.Should().Equal(
            "hops", "coffee", "path", "hops", "coffee", "path", "hops", "coffee", "path", "hops",
            "coffee", "path", "hops", "coffee", "path", "hops", "coffee", "path", "hops", "coffee");

        // Every target reached the router with ITS OWN coordinates: the tile travels with the receipt, not with the plan.
        handler.Requests.Select(request => (request.Args.X, request.Args.Y)).Should().OnlyHaveUniqueItems();
        pass.Targets.Where(target => target.Outcome == FarmhandForEachTargetOutcome.Succeeded)
            .Should().OnlyContain(target => target.ExecutionId != null && target.Tile != null);
        pass.Targets.Select(target => target.ExecutionId).OfType<string>().Should().OnlyHaveUniqueItems(
            "each target keeps its own receipt lineage, or two effects could not be told apart");
    }

    /// <summary>
    /// A ROW IS A TILE'S OCCUPANT, NOT ITS KIND: `{ occupant: "weed" }` works the weeds and reports the stones.
    ///
    /// <para>
    /// WHY THE SPELLING EXISTS. `where` could filter by POSITION and by a row's `kind`, and both answer the wrong question
    /// on a mixed patch: `kind` is what the clearing table resolves to an action, while `occupant` is what is STANDING
    /// there - so a strip of weeds and stones either sent a scythe at a rock or reported the rocks as worked.
    /// </para>
    /// <para>
    /// THE DOCUMENT IS READ BY THE MOD'S OWN READER and the rows are the fields the farm world publishes, so this is the
    /// whole lane: spelling, decision, and the count a caller reads back. A stone is `not_matched` - the existing word -
    /// and it names its own tile, because a row the filter did not claim is reported and never skipped.
    /// </para>
    /// </summary>
    [Fact]
    public void AnOccupantPredicateWorksTheWeedsAndReportsTheStonesAsNotMatched()
    {
        string document =
            "{\"source\":{\"area\":{\"x\":60,\"y\":18,\"w\":3,\"h\":1}},"
            + "\"where\":[{\"occupant\":\"weed\"}],\"do\":{\"action\":\"cut_weeds\"}}";
        FarmhandForEachArguments.TryParseDocument(document, out FarmhandForEachLoop? loop, out string reasonCode)
            .Should()
            .BeTrue(reasonCode);

        var handler = new RecordingHandler();
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "cut_weeds");
        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(
            loop!,
            "pass_occupant",
            new[] { Occupied(60, 18, 0, "weed"), Occupied(61, 18, 1, "stone"), Occupied(62, 18, 2, FarmhandForEachHealing.NoOccupant) },
            DispatchTo(router, ledger),
            () => false,
            _ => true, _ => null);

        pass.Succeeded.Should().Be(1, "the one weed is the row the filter claimed");
        pass.NotMatched.Should().Be(2, "the stone and the empty tile are reported, not skipped - a skipped row reads as a worked one");
        handler.Requests.Should().ContainSingle("no native effect may reach a tile the filter did not claim");
        pass.Targets[1].ReasonCode.Should().Be(FarmhandForEachRules.NoRuleMatchedReasonCode("stone", 61, 18));
        pass.Targets[2].ReasonCode.Should().Be(FarmhandForEachRules.NoRuleMatchedReasonCode(FarmhandForEachHealing.NoOccupant, 62, 18));
    }

    /// <summary>
    /// STOP ARRIVES BETWEEN TWO NATIVE EFFECTS. The effect that is already running finishes and keeps its receipt; the
    /// row after it is the first one stamped `Stopped`, and nothing further is dispatched.
    /// </summary>
    [Fact]
    public void StopIsCheckedBetweenTwoNativeEffectsAndTheEffectInFlightFinishes()
    {
        FarmhandForEachSource patch = Rect(60, 18, 20, 3);
        var loop = new FarmhandForEachLoop(patch, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));

        var handler = new RecordingHandler();
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "till_soil");
        bool stopRequested = false;
        // The third effect is the one that observes the player's STOP arriving mid-work.
        handler.After = _ =>
        {
            if (handler.Requests.Count == 3) stopRequested = true;
        };

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_stop", AreaRows(patch), DispatchTo(router, ledger), () => stopRequested, _ => true, _ => null);

        pass.Stopped.Should().BeTrue();
        pass.Succeeded.Should().Be(3, "the third effect ran to completion before STOP was consulted again");
        pass.StopObserved.Should().Be(57);
        handler.Requests.Should().HaveCount(3, "no native effect starts after STOP is seen");
        pass.Targets[2].Outcome.Should().Be(FarmhandForEachTargetOutcome.Succeeded);
        pass.Targets[2].ExecutionId.Should().NotBeNull("the effect in flight still owns its receipt");
        pass.Targets[3].Outcome.Should().Be(FarmhandForEachTargetOutcome.Stopped);
        pass.Targets[3].ReasonCode.Should().Be("stopped");
    }

    /// <summary>
    /// A RECEIPT THAT HAS NOT SETTLED ENDS THE PASS. The native body still owns the embodied actor, so the next target
    /// would contend with it - and "one winner per tile" must not depend on which one got there first.
    /// </summary>
    [Fact]
    public void AReceiptThatHasNotSettledEndsThePassInsteadOfContendingForTheActor()
    {
        FarmhandForEachSource patch = Rect(60, 18, 20, 3);
        var loop = new FarmhandForEachLoop(patch, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));

        var handler = new RecordingHandler(ExecutionState.Running, "in_flight");
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "till_soil");

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_busy", AreaRows(patch), DispatchTo(router, ledger), () => false, _ => true, _ => null);

        handler.Requests.Should().HaveCount(1, "one native body at a time");
        pass.Deferred.Should().Be(60, "the row that started it and the 59 that must wait for it");
        pass.Targets[0].State.Should().Be(ExecutionState.Running);
        pass.Targets[1].ReasonCode.Should().Be("actor_busy:row0c1");
        pass.Stopped.Should().BeFalse("a busy actor is not a STOP, and a reader must be able to tell them apart");
    }

    /// <summary>The bound is the source's own, and over it the answer says HOW MANY rows it did not address.</summary>
    [Fact]
    public void OverTheRowBoundThePassSaysHowManyRowsItDidNotAddress()
    {
        var loop = new FarmhandForEachLoop(Rect(0, 0, 1, 1), null, new FarmhandForEachEffect(new FarmhandForEachStep("cut_weeds")));
        var handler = new RecordingHandler();
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "cut_weeds");
        var rows = new List<FarmhandForEachRow>();
        for (int index = 0; index < 100; index++)
            rows.Add(new FarmhandForEachRow(index, 0, 0, index, Row()));

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_bound", rows, DispatchTo(router, ledger), () => false, _ => true, _ => null);

        pass.Decided.Should().Be(FarmhandForEachSource.MaximumRows);
        pass.Omitted.Should().Be(100 - FarmhandForEachSource.MaximumRows);
        pass.Succeeded.Should().Be(FarmhandForEachSource.MaximumRows);
        (pass.Decided + pass.Omitted).Should().Be(100, "no row may leave the answer without being counted somewhere");
    }

    /// <summary>A row no rule claims is named with its kind and its tile; it is never silently skipped.</summary>
    [Fact]
    public void AnUnclaimedRowNamesItsKindAndItsTile()
    {
        var loop = new FarmhandForEachLoop(Rect(60, 18, 2, 1), new[] { Stride(FarmhandForEachPredicate.ColOperator, 3, 1) }, new FarmhandForEachEffect(new FarmhandForEachStep("cut_weeds")));
        var handler = new RecordingHandler();
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "cut_weeds");
        var rows = new List<FarmhandForEachRow>
        {
            new(60, 18, 0, 0, Row("rock")),
            new(61, 18, 1, 0, Row("rock")),
        };

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_miss", rows, DispatchTo(router, ledger), () => false, _ => true, _ => null);

        pass.NotMatched.Should().Be(1);
        pass.Targets[0].ReasonCode.Should().Be("no_rule_matched:rock@60,18");
        pass.Succeeded.Should().Be(1);
        pass.Targets[1].Tile.Should().Be("61,18", "the receipt names the tile, not only the row index");
    }

    /// <summary>
    /// A pass that claimed NO row says so ONCE, naming the test and what the tiles carried - not once per tile.
    ///
    /// <para>
    /// Measured 2026-11-11 (`round45`, `plan_66_dc0f5736a9faf977`): a 48-tile pass answered forty-eight entries of
    /// <c>no_rule_matched:ground@x,y</c>, one per tile, and no caller can act on forty-eight tiles. When EVERY row misses,
    /// the fact is about the patch: which test the caller wrote, and what the tiles carry instead. The per-tile word stays
    /// for the MIXED pass (<see cref="AnUnclaimedRowNamesItsKindAndItsTile"/>), where the tiles differ and the row is the
    /// news.
    /// </para>
    /// </summary>
    [Fact]
    public void APassThatClaimsNoRowSaysSoOnceWithItsTestAndItsOccupants()
    {
        var loop = new FarmhandForEachLoop(
            Rect(60, 18, 3, 1),
            new[]
            {
                new FarmhandForEachPredicate(
                    FarmhandForEachHealing.OccupantField,
                    FarmhandForEachComparison.Eq,
                    new[] { FarmhandForEachValue.Of("weed") }),
            },
            new FarmhandForEachEffect(new FarmhandForEachStep("cut_weeds")));
        var handler = new RecordingHandler();
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "cut_weeds");
        var rows = new[]
        {
            Occupied(60, 18, 0, "stone"),
            Occupied(61, 18, 1, FarmhandForEachHealing.NoOccupant),
            Occupied(62, 18, 2, "stone"),
        };

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(
            loop, "pass_none", rows, DispatchTo(router, ledger), () => false, _ => true, _ => null);

        pass.NotMatched.Should().Be(3);
        handler.Requests.Should().BeEmpty("no row met the test, so no native effect may run");
        string reason = pass.Targets[0].ReasonCode!;
        pass.Targets.Select(target => target.ReasonCode).Distinct(StringComparer.Ordinal).Should().ContainSingle(
            "every row missed the same test, which is one statement about the patch");
        reason.Should().Be(
            $"{FarmhandForEachRules.NoRowMatchedWhere}:occupant_eq_weed:stone_none",
            "the code names the test the caller wrote and the occupants in row order, once");
        reason.Should().NotContain(
            FarmhandForEachRules.NoRuleMatchedReasonCode("stone", 60, 18),
            "the per-tile word is the mixed pass's, not this one");
        BodyProgramValidation.IsReasonCode(reason).Should().BeTrue(
            "a node's reason code must satisfy the journal's grammar, or the answer arrives with no reason at all");
    }

    /// <summary>The engine's own reason code and the tile travel with the target, verbatim.</summary>
    [Fact]
    public void ARefusedNativeEffectKeepsTheEngineReasonCodeAndTheTile()
    {
        var loop = new FarmhandForEachLoop(Rect(60, 18, 1, 1), null, new FarmhandForEachEffect(new FarmhandForEachStep("chop_tree")));
        var handler = new RecordingHandler(ExecutionState.Failed, "no_native_path", "from=60,18;to=60,18;target_enclosed=true");
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "chop_tree");

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_refused", AreaRows(Rect(60, 18, 1, 1)), DispatchTo(router, ledger), () => false, _ => true, _ => null);

        pass.Failed.Should().Be(1);
        pass.Targets[0].ReasonCode.Should().Be("no_native_path");
        pass.Targets[0].State.Should().Be(ExecutionState.Failed);
        pass.Targets[0].Tile.Should().Be("60,18");
        pass.Targets[0].Evidence.Should().Be("from=60,18;to=60,18;target_enclosed=true");
        pass.Targets[0].Target!.ActionId.Should().Be("chop_tree");
    }

    /// <summary>
    /// RE-ENTERING THE SAME PASS APPLIES NOTHING TWICE. The row's identity is derived from the pass's, so the router
    /// answers with the receipt it already recorded - which is what makes a STOP, a reconnect or a deferral resumable.
    /// </summary>
    [Fact]
    public void ReEnteringTheSamePassReplaysEachRowsReceiptInsteadOfApplyingItAgain()
    {
        FarmhandForEachSource patch = Rect(60, 18, 3, 1);
        var loop = new FarmhandForEachLoop(patch, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
        var handler = new RecordingHandler();
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "till_soil");
        FarmhandForEachDispatch dispatch = DispatchTo(router, ledger);

        FarmhandForEachPassResult first = FarmhandForEachExpansion.Expand(loop, "pass_replay", AreaRows(patch), dispatch, () => false, _ => true, _ => null);
        FarmhandForEachPassResult second = FarmhandForEachExpansion.Expand(loop, "pass_replay", AreaRows(patch), dispatch, () => false, _ => true, _ => null);

        handler.Requests.Should().HaveCount(3, "three rows, three native effects, however many times the pass is entered");
        second.Succeeded.Should().Be(3);
        second.Targets.Select(target => target.ExecutionId)
            .Should().Equal(first.Targets.Select(target => target.ExecutionId), "the same row keeps the identity it was given");
    }

    /// <summary>
    /// AN EFFECT THAT THREW IS THE ROUTER'S INCIDENT, NOT THIS FILE'S. The router records a terminal `Uncertain` receipt
    /// named `handler_exception`; the pass reports that receipt verbatim and never retries that row.
    /// </summary>
    [Fact]
    public void AnEffectThatThrewKeepsTheRoutersOwnUncertainReceiptAndIsNotRetried()
    {
        var loop = new FarmhandForEachLoop(Rect(60, 18, 2, 1), null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
        var handler = new ThrowingHandler();
        var router = new FarmhandActionRouter();
        router.Register(
            new FarmhandActionRegistration("till_soil", "test", 1, FarmhandActionLifecycle.Published, FarmhandOperationKind.Execution, FarmhandActionHandlerGroup.Farming),
            handler);
        var ledger = new Ledger();

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_throw", AreaRows(Rect(60, 18, 2, 1)), DispatchTo(router, ledger), () => false, _ => true, _ => null);

        handler.Calls.Should().Be(2, "each row is its own effect: an unknown result on one tile does not stop the next");
        pass.Failed.Should().Be(2);
        pass.Targets[0].ReasonCode.Should().Be("handler_exception");
        pass.Targets[0].State.Should().Be(ExecutionState.Uncertain, "the side effect may be unknown, and the answer must say so");
        pass.Targets[0].ExecutionId.Should().NotBeNull("the uncertain row still keeps the lineage a recovery would name");
    }

    /// <summary>A loop this product cannot run is refused before a single row is read.</summary>
    [Fact]
    public void AnInvalidLoopIsRefusedBeforeAnyRowIsRead()
    {
        var loop = new FarmhandForEachLoop(Rect(0, 0, 20, 20), null, new FarmhandForEachEffect(new FarmhandForEachStep("cut_weeds")));
        loop.IsValid.Should().BeFalse();
        var handler = new RecordingHandler();
        (FarmhandActionRouter router, Ledger ledger) = Table(handler, "cut_weeds");

        Action expand = () => FarmhandForEachExpansion.Expand(loop, "pass_invalid", AreaRows(Rect(0, 0, 1, 1)), DispatchTo(router, ledger), () => false, _ => true, _ => null);

        expand.Should().Throw<ArgumentException>();
        handler.Requests.Should().BeEmpty();
    }

    /// <summary>
    /// The ordered rule list is spelled once. A reader that rebuilt it from `Where`/`Then` itself would be a second
    /// enumeration of the same pass, and the two would disagree the first time a rule was added.
    /// </summary>
    [Fact]
    public void TheRulesOfAPassAreEnumeratedInTheOrderTheyAreDecided()
    {
        var own = new FarmhandForEachEffect(new FarmhandForEachStep("cut_weeds"));
        var second = new FarmhandForEachRule(new[] { Stride(FarmhandForEachPredicate.RowOperator, 2, 1) }, Plant("coffee"));
        var loop = new FarmhandForEachLoop(Rect(60, 18, 3, 3), null, own, new[] { second });

        loop.Rules.Should().HaveCount(2);
        loop.Rules[0].Do.Should().Be(own, "the loop's own effect is its FIRST rule");
        loop.Rules[1].Should().Be(second);
        loop.Rules[0].Where.Should().BeNull("an absent predicate list means every row, and is carried through as absent");

        var tooMany = new FarmhandForEachLoop(
            Rect(60, 18, 3, 3),
            null,
            own,
            Enumerable.Range(0, FarmhandForEachLoop.MaximumRules).Select(_ => second).ToArray());
        tooMany.IsValid.Should().BeFalse("a pass with more rules than the bound is refused, not truncated");
    }
}
