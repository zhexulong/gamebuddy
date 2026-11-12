using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A row's `do` is a CHAIN: the steps one tile is worked with, in order, in one pass.
///
/// <para>
/// WHY THIS IS THE LAST STRUCTURAL REASON A 3x20 STRIP COULD NOT BE DONE IN ONE PASS. A `for_each` row could name exactly one
/// action, and farm work is a chain per tile - clear, till, water, sow. The strip was therefore worked by four separate
/// passes, each waking the actor, ordering a node, and minting a receipt for the same sixty tiles - and each pass reported
/// the tiles the previous one had just prepared as if nobody had asked for them. One row is one tile's work: the steps run
/// in the order the caller wrote them, and the pass reports every step it took.
/// </para>
/// <para>
/// THE PROPERTIES PINNED HERE, and each one is a place the honest answer is not the obvious one:
///  - a step that did not happen ends the chain AT that step, and the step already taken is not rolled back (the world does
///    not roll back a swing);
///  - a blocked step is the heal's case unchanged, including the destructive clear it refuses;
///  - STOP and a receipt that has not settled each end the chain, and a later pass re-enters it without applying step one
///    twice;
///  - a row that never asked for a chain answers exactly what it answered before, in the same words.
/// </para>
/// <para>
/// The dispatch seam is a stand-in for the native body, which is the one thing a headless test does not own: it models the
/// two world facts a chain has to cope with - a tile carrying something refuses the action asked of it, and a tile that was
/// not tilled refuses a seed - and decides nothing else. Everything that DECIDES (the rule matcher, the catalogue join, the
/// chain, the expansion) is production code.
/// </para>
/// </summary>
public sealed class FarmhandForEachChainTests
{
    private static FarmhandForEachSource Strip(int x, int y, int width) =>
        new(x, y, width, 1);

    private static FarmhandForEachEffect Chain(params string[] actionIds) =>
        new(actionIds.Select(actionId => new FarmhandForEachStep(actionId)).ToArray());

    /// <summary>Every action that declares a `TargetFamily`: the actions a per-tile chain can be written from.</summary>
    private static IEnumerable<string> TargetFamilyActionIds() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.TargetFamily is { Length: > 0 })
            .Select(registration => registration.ActionId);

    /// <summary>
    /// THE RED PROOF, in the real objective shape: six bare tiles, `do: [till_soil, plant_seed]`.
    ///
    /// Before the chain, one pass ran exactly one action per tile - the hoe - and the seed needed a second pass over the same
    /// six tiles (and a third for water). After it, ONE pass performs twelve native effects and every row reports both of its
    /// steps, in the order the caller wrote them.
    /// </summary>
    [Fact]
    public void ASixTileStripIsTilledAndSownInOnePass()
    {
        FarmhandForEachSource strip = Strip(60, 18, 6);
        var loop = new FarmhandForEachLoop(
            strip,
            null,
            new FarmhandForEachEffect(
                new FarmhandForEachStep("till_soil"),
                new FarmhandForEachStep("plant_seed", new Dictionary<string, string>(StringComparer.Ordinal) { ["seed"] = "hops" })));
        var world = new TileWorld();

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_chain", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled, _ => null);

        pass.Decided.Should().Be(6);
        pass.Succeeded.Should().Be(6, "both steps of every tile happened in this one pass");
        pass.Refused.Should().Be(0);
        pass.Steps.Should().Be(12, "six tiles by two native effects, where the old form needed two passes to do six");

        foreach (FarmhandForEachTargetResult row in pass.Targets)
        {
            row.Steps.Should().NotBeNull("every row that dispatched reports the steps it took");
            row.Steps!.Select(step => step.ActionId).Should().Equal(
                new[] { "till_soil", "plant_seed" },
                "the chain runs in the caller's order on tile {0}",
                row.Tile);
            row.Steps!.Select(step => step.Outcome).Should().OnlyContain(outcome => outcome == FarmhandForEachTargetOutcome.Succeeded);
            row.StoppedAt.Should().BeNull("this chain ran to its end");
        }

        foreach (int column in Enumerable.Range(0, 6))
            world.Dispatched.Where(target => target.X == 60 + column).Select(target => target.ActionId)
                .Should().Equal(new[] { "till_soil", "plant_seed" }, "the tile is tilled and only then sown");
    }

    /// <summary>
    /// A STEP WHOSE PRECONDITION IS NOT MET ENDS THE CHAIN AT THAT STEP. The precondition is the ACTION's own - the same
    /// admission a flat request meets, asked against the world as the previous step left it - so there is no second table of
    /// them here. What already happened is kept: the world does not roll a swing back.
    /// </summary>
    [Fact]
    public void AStepWhosePreconditionIsNotMetStopsTheChainWhereItStopped()
    {
        FarmhandForEachSource strip = Strip(60, 18, 1);
        var loop = new FarmhandForEachLoop(strip, null, Chain("water_crop", "plant_seed"));
        var world = new TileWorld();

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_precondition", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled, _ => null);

        FarmhandForEachTargetResult row = pass.Targets.Single();
        row.Outcome.Should().Be(FarmhandForEachTargetOutcome.Failed, "the step ran and its own admission refused it");
        row.State.Should().Be(ExecutionState.Rejected, "a precondition refused before any native effect is `Rejected`, one layer down");
        row.ReasonCode.Should().Be("soil_not_tilled", "the seed names what it needs, which is the fact to fix");
        row.StoppedAt.Should().Be("1:soil_not_tilled", "and the row says WHICH step refused, or the chain's length would have to be guessed");
        row.Steps!.Select(step => step.Outcome).Should().Equal(
            FarmhandForEachTargetOutcome.Succeeded,
            FarmhandForEachTargetOutcome.Failed);
        world.Dispatched.Select(target => target.ActionId).Should().Equal(
            new[] { "water_crop", "plant_seed" },
            "the step that ran is not rolled back and the step that refused is not retried into a guess");
        pass.Succeeded.Should().Be(0, "a row whose chain stopped did not do what it was asked");
        pass.Failed.Should().Be(1);
        pass.Steps.Should().Be(2);
    }

    /// <summary>
    /// A BLOCKED STEP IS THE HEAL'S CASE, UNCHANGED. Her own crop blocks the hoe, the catalogue's only swing for that
    /// occupant is the destructive one, so the row answers `no_safe_clear:crop:scythe_crop` and the chain stops on the step
    /// that was blocked - nothing is scythed, and the seed step is never reached on a tile that was not prepared.
    /// </summary>
    [Fact]
    public void AChainBlockedByHerOwnCropStopsOnTheStepThatWasBlocked()
    {
        FarmhandForEachSource strip = Strip(60, 18, 2);
        var loop = new FarmhandForEachLoop(strip, null, Chain("till_soil", "plant_seed"));
        var world = new TileWorld();
        world.Occupy(60, 18, "crop");

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_crop", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled, _ => null);

        FarmhandForEachTargetResult crop = pass.Targets.Single(target => target.X == 60);
        crop.Outcome.Should().Be(FarmhandForEachTargetOutcome.Refused);
        crop.ReasonCode.Should().Be("no_safe_clear:crop:scythe_crop");
        crop.StoppedAt.Should().Be("0:no_safe_clear:crop:scythe_crop", "the chain stopped at the step that was refused");
        crop.Steps.Should().ContainSingle("nothing after the blocked step ran, so the row took exactly one step");

        FarmhandForEachTargetResult bare = pass.Targets.Single(target => target.X == 61);
        bare.Outcome.Should().Be(FarmhandForEachTargetOutcome.Succeeded);
        bare.StoppedAt.Should().BeNull();

        world.Carries(60, 18).Should().BeTrue("her crop is still standing");
        world.Dispatched.Should().NotContain(target => string.Equals(target.ActionId, "scythe_crop", StringComparison.Ordinal));
        world.Dispatched.Where(target => target.X == 60).Should().ContainSingle("one refused step, one tile, no second attempt");
        pass.Succeeded.Should().Be(1);
        pass.Refused.Should().Be(1);
        pass.Steps.Should().Be(3, "the bare tile took both steps and the crop tile took the one that was refused");
    }

    /// <summary>
    /// STOP LANDS BETWEEN TWO STEPS OF ONE ROW exactly as it does between two rows: the step in flight finishes, the next one
    /// does not start, and the row says which step it stopped before.
    /// </summary>
    [Fact]
    public void StopBetweenTwoStepsOfOneRowEndsTheChainAndKeepsTheStepThatRan()
    {
        FarmhandForEachSource strip = Strip(60, 18, 2);
        var loop = new FarmhandForEachLoop(strip, null, Chain("till_soil", "plant_seed"));
        var world = new TileWorld();

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(
            loop,
            "pass_stop_chain",
            world.Rows(strip),
            world.Dispatch,
            () => world.Dispatched.Count > 0,
            world.IsEnabled, _ => null);

        pass.Stopped.Should().BeTrue();
        pass.Targets[0].Outcome.Should().Be(FarmhandForEachTargetOutcome.Stopped);
        pass.Targets[0].StoppedAt.Should().Be("1:stopped");
        pass.Targets[0].Steps.Should().ContainSingle("the hoe ran and the seed did not start");
        pass.Targets[0].Steps![0].Outcome.Should().Be(FarmhandForEachTargetOutcome.Succeeded);
        pass.Targets[1].Outcome.Should().Be(FarmhandForEachTargetOutcome.Stopped);
        world.Dispatched.Should().ContainSingle("no native effect starts after STOP is seen");
    }

    /// <summary>
    /// A STEP THAT HAS NOT SETTLED ENDS THE CHAIN AND THE PASS - and a later pass continues it WITHOUT applying the settled
    /// step twice, because a row's identity is per row AND per step. `Deferred` is not a stop, so the row names no
    /// `stopped_at`: the actor is busy and the work is resumed, which is not the same fact as "this tile stopped".
    /// </summary>
    [Fact]
    public void AStepThatHasNotSettledEndsTheChainAndTheNextPassContinuesIt()
    {
        FarmhandForEachSource strip = Strip(60, 18, 1);
        var loop = new FarmhandForEachLoop(strip, null, Chain("till_soil", "plant_seed"));
        var world = new TileWorld { HoldPlant = true };

        FarmhandForEachPassResult first = FarmhandForEachExpansion.Expand(loop, "pass_deferred", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled, _ => null);

        first.Deferred.Should().Be(1);
        first.Targets[0].Outcome.Should().Be(FarmhandForEachTargetOutcome.Deferred);
        first.Targets[0].StoppedAt.Should().BeNull("a busy actor is not a tile that stopped being worked");
        first.Targets[0].Steps!.Select(step => step.Outcome).Should().Equal(
            FarmhandForEachTargetOutcome.Succeeded,
            FarmhandForEachTargetOutcome.Deferred);

        world.HoldPlant = false;
        FarmhandForEachPassResult second = FarmhandForEachExpansion.Expand(loop, "pass_deferred", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled, _ => null);

        second.Targets[0].Outcome.Should().Be(FarmhandForEachTargetOutcome.Succeeded);
        second.Targets[0].Steps!.Select(step => step.ActionId).Should().Equal("till_soil", "plant_seed");
        world.Dispatched.Select(target => target.ActionId).Should().Equal(
            new[] { "till_soil", "plant_seed" },
            "the tilled step settled in the first pass and replays from its receipt - it is not tilled a second time");
    }

    /// <summary>
    /// THE RECEIPT WORDS. A chained row carries its steps in order and, when it stopped early, the step it stopped at. A row
    /// that never asked for a chain carries NEITHER: `action`, `state` and `reasonCode` already say everything a one-action
    /// row has to say, and adding a list of one to every row of every existing pass would change answers nobody asked to
    /// change.
    /// </summary>
    [Fact]
    public void AChainedRowsReceiptCarriesItsStepsAndTheStepItStoppedAt()
    {
        FarmhandForEachSource strip = Strip(60, 18, 2);
        var loop = new FarmhandForEachLoop(strip, null, Chain("till_soil", "plant_seed"));
        var world = new TileWorld();
        world.Occupy(60, 18, "crop");

        FarmhandForEachPassResult chained = FarmhandForEachExpansion.Expand(loop, "pass_receipt", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled, _ => null);
        FarmhandForEachTargetResult crop = chained.Targets.Single(target => target.X == 60);
        string refusedRow = RouteReenteringBodyProgramExecutor.RowJson(
            crop.X, crop.Y, crop.Target?.ActionId, "refused", crop.ReasonCode, crop.Healed, crop.Steps, crop.StoppedAt);
        refusedRow.Should().Contain("\"steps\":[{\"step\":0,\"action\":\"till_soil\"");
        refusedRow.Should().Contain("\"stopped_at\":\"0:no_safe_clear:crop:scythe_crop\"");

        var single = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
        FarmhandForEachTargetResult oneAction = FarmhandForEachExpansion
            .Expand(single, "pass_single", world.Rows(Strip(70, 18, 1)), world.Dispatch, () => false, world.IsEnabled, _ => null)
            .Targets.Single();
        RouteReenteringBodyProgramExecutor.RowJson(
                oneAction.X, oneAction.Y, oneAction.Target?.ActionId, "succeeded", oneAction.ReasonCode, oneAction.Healed, oneAction.Steps, oneAction.StoppedAt)
            .Should()
            .NotContain("steps")
            .And.NotContain("stopped_at", "a one-action row answers exactly the words it answered before the chain existed");
    }

    /// <summary>
    /// THE GATE, over the catalogue rather than over a list. Population: every action the catalogue publishes with a
    /// `TargetFamily` - the actions a per-tile chain can be written from, derived from `FarmhandActionCatalog.Registrations`
    /// so an action added tomorrow is examined without anyone remembering to add it.
    ///
    /// <para>
    /// Property: a two-step chain over a clean tile performs BOTH steps in ONE pass and reports both. A chain that silently
    /// dropped its second step would look exactly like a one-action pass over a prepared tile - the tile reads as finished -
    /// which is the defect class this whole form exists to remove, so the failure names the row, the step and the action.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryTargetFamilyActionRunsAsAStepOfAChainInOnePass()
    {
        var failures = new List<string>();
        int examined = 0;
        foreach (string actionId in TargetFamilyActionIds())
        {
            examined += 1;
            FarmhandForEachSource strip = Strip(60, 18, 2);
            var loop = new FarmhandForEachLoop(
                strip,
                null,
                new FarmhandForEachEffect(new FarmhandForEachStep(actionId), new FarmhandForEachStep(actionId)));
            // A dispatch that does its thing: this gate asks whether the CHAIN reaches a step, so nothing here may refuse.
            var world = new RecordingEffect();

            FarmhandForEachPassResult pass = FarmhandForEachExpansion
                .Expand(loop, "pass_gate_chain", world.Rows(strip), world.Dispatch, () => false, _ => true, _ => null);

            foreach (FarmhandForEachTargetResult row in pass.Targets)
            {
                for (int index = 0; index < 2; index++)
                {
                    bool taken = row.Steps is { } steps
                        && steps.Count > index
                        && steps[index].Outcome == FarmhandForEachTargetOutcome.Succeeded
                        && string.Equals(steps[index].ActionId, actionId, StringComparison.Ordinal);
                    if (taken) continue;
                    failures.Add(string.Create(
                        CultureInfo.InvariantCulture,
                        $"chain_step_silently_skipped:{row.LocalColumn}:{index}:{actionId} "
                        + $"(row answered {row.Outcome}/{row.ReasonCode ?? "no_reason"}, "
                        + $"steps={(row.Steps is null ? "none" : row.Steps.Count.ToString(CultureInfo.InvariantCulture))})"));
                }
            }
        }

        examined.Should().BeGreaterThan(0, "the catalogue publishes per-tile actions, so the population is never empty");
        failures.Should().BeEmpty(
            $"every action that declares a TargetFamily must be reachable as a chain step, in one pass; examined {examined} actions");
    }

    /// <summary>
    /// THE OTHER HALF OF THE GATE: a chain that is blocked may never run PAST the block. Population: the same catalogue set,
    /// each one asked as the SECOND step of a chain over her own crop - the tile the heal refuses with `no_safe_clear`.
    ///
    /// <para>
    /// Property: the chain stops at the step that was blocked, names it in `stopped_at`, and the blocked step's action never
    /// reaches the native body. A pass that carried on would sow a tile it had not prepared, and the row would claim a step
    /// on a tile the refusal was about.
    /// </para>
    /// </summary>
    [Fact]
    public void AChainNeverRunsPastTheStepThatWasBlocked()
    {
        var failures = new List<string>();
        int examined = 0;
        foreach (string actionId in TargetFamilyActionIds())
        {
            examined += 1;
            FarmhandForEachSource strip = Strip(60, 18, 1);
            var loop = new FarmhandForEachLoop(
                strip,
                null,
                new FarmhandForEachEffect(new FarmhandForEachStep("till_soil"), new FarmhandForEachStep(actionId)));
            var world = new TileWorld();
            world.Occupy(60, 18, "crop");

            FarmhandForEachTargetResult row = FarmhandForEachExpansion
                .Expand(loop, "pass_gate_blocked", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled, _ => null)
                .Targets.Single();

            bool stopped = row.StoppedAt is { Length: > 0 } stoppedAt
                && stoppedAt.StartsWith("0:", StringComparison.Ordinal)
                && row.Steps is { Count: 1 };
            // Exactly one native effect may have run: the blocked step. Comparing action ids would pass for a chain whose two
            // steps are the same action, which is why the count is what is asserted.
            bool past = world.Dispatched.Count > 1;
            if (stopped && !past) continue;
            failures.Add(string.Create(
                CultureInfo.InvariantCulture,
                $"chain_ran_past_a_blocked_step:0:0:{actionId} "
                + $"(stopped_at={row.StoppedAt ?? "none"}, steps={(row.Steps is null ? "none" : row.Steps.Count.ToString(CultureInfo.InvariantCulture))}, "
                + $"dispatched_past_the_block={past})"));
        }

        examined.Should().BeGreaterThan(0, "the catalogue publishes per-tile actions, so the population is never empty");
        failures.Should().BeEmpty($"a chain stops where it was blocked; examined {examined} actions");
    }

    /// <summary>
    /// A dispatch that always does its thing, and reports every native effect it ran.
    ///
    /// The chain gates ask whether a STEP is reached, not whether a world fact allows it, so this seam may not refuse - the
    /// refusal cases are the healing gate's population, and mixing the two would make a gate that fails for a reason it is not
    /// about.
    /// </summary>
    private sealed class RecordingEffect
    {
        private long revision;

        internal List<FarmhandForEachTarget> Dispatched { get; } = new();

        internal IEnumerable<FarmhandForEachRow> Rows(FarmhandForEachSource source) =>
            FarmhandForEachRules.AreaRows(source).Select(row => new FarmhandForEachRow(
                row.X,
                row.Y,
                row.LocalColumn,
                row.LocalRow,
                new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
                {
                    ["kind"] = FarmhandForEachValue.Of("empty_tillable"),
                    [FarmhandForEachHealing.OccupantField] = FarmhandForEachValue.Of(FarmhandForEachHealing.NoOccupant),
                }));

        internal bool Dispatch(
            FarmhandForEachTarget target,
            string requestId,
            string executionId,
            out LocalExecutionReceipt receipt,
            out string reasonCode)
        {
            this.Dispatched.Add(target);
            reasonCode = "accepted";
            this.revision += 1;
            receipt = new LocalExecutionReceipt(executionId, requestId, ExecutionState.Succeeded, "worked", this.revision, null);
            return true;
        }
    }

    /// <summary>
    /// The farm as the pass reads it, and the world's own answer about working one tile.
    ///
    /// It models the two facts a chain has to cope with - a tile carrying something refuses the action asked of it, and a seed
    /// refuses a tile that was not tilled - and it replays a request identity the way the router does, which is what makes
    /// "a later pass continues instead of re-applying" testable. It decides nothing else.
    /// </summary>
    private sealed class TileWorld
    {
        private readonly Dictionary<(int X, int Y), string> occupants = new();
        private readonly HashSet<(int X, int Y)> tilled = new();
        private readonly Dictionary<string, LocalExecutionReceipt> receipts = new(StringComparer.Ordinal);
        private long revision;

        internal List<FarmhandForEachTarget> Dispatched { get; } = new();

        /// <summary>Whether the first `plant_seed` swing is still in flight when the pass asks (a receipt that has not settled).</summary>
        internal bool HoldPlant { get; set; }

        internal Func<string, bool> IsEnabled => _ => true;

        internal void Occupy(int x, int y, string occupant) => this.occupants[(x, y)] = occupant;

        internal bool Carries(int x, int y) => this.occupants.ContainsKey((x, y));

        internal IEnumerable<FarmhandForEachRow> Rows(FarmhandForEachSource source) =>
            FarmhandForEachRules.AreaRows(source).Select(row => new FarmhandForEachRow(
                row.X,
                row.Y,
                row.LocalColumn,
                row.LocalRow,
                this.Fields(row.X, row.Y)));

        internal bool Dispatch(
            FarmhandForEachTarget target,
            string requestId,
            string executionId,
            out LocalExecutionReceipt receipt,
            out string reasonCode)
        {
            reasonCode = "accepted";
            // A request identity answers with the receipt it already recorded, exactly as the router does: that is what makes a
            // second pass resume a chain instead of tilling the tile again.
            if (this.receipts.TryGetValue(requestId, out LocalExecutionReceipt? recorded))
            {
                receipt = recorded.State == ExecutionState.Running && !this.HoldPlant
                    ? this.Remember(requestId, executionId, this.Answer(target))
                    : recorded;
                return true;
            }
            this.Dispatched.Add(target);
            receipt = this.Remember(requestId, executionId, this.Answer(target));
            return true;
        }

        private (ExecutionState State, string ReasonCode) Answer(FarmhandForEachTarget target)
        {
            var tile = (target.X ?? -1, target.Y ?? -1);
            if (this.occupants.ContainsKey(tile) && !string.Equals(target.ActionId, "scythe_crop", StringComparison.Ordinal))
                return (ExecutionState.Rejected, $"soil_not_diggable:occupied:{this.occupants[tile]}");
            return target.ActionId switch
            {
                "till_soil" => this.Till(tile),
                "plant_seed" when !this.tilled.Contains(tile) => (ExecutionState.Rejected, "soil_not_tilled"),
                "plant_seed" when this.HoldPlant => (ExecutionState.Running, "in_flight"),
                _ => (ExecutionState.Succeeded, "worked"),
            };
        }

        private (ExecutionState State, string ReasonCode) Till((int X, int Y) tile)
        {
            this.tilled.Add(tile);
            return (ExecutionState.Succeeded, "tilled");
        }

        private LocalExecutionReceipt Remember(string requestId, string executionId, (ExecutionState State, string ReasonCode) answer)
        {
            this.revision += 1;
            var receipt = new LocalExecutionReceipt(executionId, requestId, answer.State, answer.ReasonCode, this.revision, null);
            this.receipts[requestId] = receipt;
            return receipt;
        }

        private Dictionary<string, FarmhandForEachValue> Fields(int x, int y) =>
            new(StringComparer.Ordinal)
            {
                ["kind"] = FarmhandForEachValue.Of(this.occupants.TryGetValue((x, y), out string? occupant) ? occupant : "empty_tillable"),
                [FarmhandForEachHealing.OccupantField] = FarmhandForEachValue.Of(
                    this.occupants.TryGetValue((x, y), out occupant) ? occupant : FarmhandForEachHealing.NoOccupant),
            };
    }
}
