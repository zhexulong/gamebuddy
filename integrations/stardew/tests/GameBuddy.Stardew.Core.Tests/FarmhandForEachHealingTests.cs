using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A `for_each` pass heals itself from the catalogue's own `Clears` declarations: a row the tile refused is opened by the
/// action that declaration names, and the requested action is retried on the same tile, in the same pass.
///
/// <para>
/// WHY THESE CASES. Measured `round44`: one pass over a strip answered `worked 34 · not_matched 26`, and the tiles it did
/// not work were the ones with something standing on them. The pass had one action per row and no way to say "there is a
/// weed here; cut it and try again". So the cases below are: the strip that used to leave a tile behind, the bound (one
/// clear, one retry), the refusal that names an occupant nothing removes, and the GATE - every `Clears` declaration in the
/// catalogue, driven through a pass, because a declaration the pass can never reach is a promise the catalogue cannot keep.
/// </para>
/// <para>
/// The dispatch seam is a stand-in for the native body, which is the one thing a headless test does not own: it models the
/// world's own answer - a tile that still carries something refuses the action asked of it, and the action the catalogue
/// names removes it. Everything that DECIDES (the rule matcher, the catalogue join, the expansion) is production code.
/// </para>
/// </summary>
public sealed class FarmhandForEachHealingTests
{
    /// <summary>How one healed row says what it removed, spelled once so the gate and the strip read the same word.</summary>
    private static string Healed(string occupant, string clearingAction) =>
        FarmhandForEachHealing.HealedToken(occupant, clearingAction);

    private static FarmhandForEachSource Strip(int x, int y, int width) =>
        new(FarmhandForEachSource.AreaKind, x, y, width, 1);

    /// <summary>
    /// THE RED PROOF: a six-tile strip whose third tile carries a weed, requested `till_soil`.
    ///
    /// Before this behaviour the row on that tile answered the hoe's own refusal and the pass left the tile behind - and
    /// the caller's only reading of it was "the loop does not work". The weed is not the caller's problem: the catalogue
    /// already declares that `cut_weeds` removes one, so the pass cuts it and tills the tile.
    /// </summary>
    [Fact]
    public void AWeedOnATillableStripIsCutAndItsTileIsTilledInTheSamePass()
    {
        FarmhandForEachSource strip = Strip(60, 18, 6);
        var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
        var world = new TileWorld();
        world.Occupy(62, 18, "weed", "cut_weeds");

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_strip", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled);

        pass.Decided.Should().Be(6);
        pass.Succeeded.Should().Be(6, "every tile of the strip is worked, including the one the weed was on");
        pass.Failed.Should().Be(0);
        pass.Refused.Should().Be(0);
        pass.NotMatched.Should().Be(0, "no tile of the strip is left to somebody else");
        pass.Healed.Should().Be(1, "the pass says how many tiles it had to open");

        FarmhandForEachTargetResult weedy = pass.Targets.Single(target => target.X == 62);
        weedy.Outcome.Should().Be(FarmhandForEachTargetOutcome.Succeeded);
        weedy.Healed.Should().Be(Healed("weed", "cut_weeds"));
        weedy.Target!.ActionId.Should().Be(
            "till_soil",
            "the row reports the action it was ASKED for; the swing that opened the tile is a means, not the answer");

        world.Dispatched.Where(target => target.X == 62).Select(target => target.ActionId).Should().Equal(
            new[] { "till_soil", "cut_weeds", "till_soil" },
            "the hoe was refused, the weed was cut, and the hoe ran on the same tile - in that order");
    }

    /// <summary>
    /// THE REGRESSION, in the shape it shipped: a six-tile strip whose third tile carries HER OWN crop, requested
    /// `till_soil`.
    ///
    /// <para>
    /// `scythe_crop` declares that it removes the occupant `crop`, so inverting the declarations answered "a crop is on
    /// this tile" with a scythe: the reading was `dispatched: till_soil, scythe_crop` and the crop gone - a destructive
    /// effect the player could not foresee, produced by a step neither she nor the player wrote. The tile is HERS and the
    /// action that resolves it is the harvest (`harvest_crop`), so the pass must refuse the tile by name and leave the
    /// crop standing.
    /// </para>
    /// </summary>
    [Fact]
    public void HerOwnCropIsNeverScythedToOpenATillableTile()
    {
        FarmhandForEachSource strip = Strip(60, 18, 6);
        var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
        var world = new TileWorld();
        world.Occupy(62, 18, "crop", "scythe_crop");

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_crop", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled);

        world.Carries(62, 18).Should().BeTrue("her crop is still standing after the pass");
        world.Dispatched.Where(target => target.X == 62).Select(target => target.ActionId).Should().Equal(
            new[] { "till_soil" },
            "the hoe was refused and nothing else was swung at her crop - least of all a scythe");

        pass.Decided.Should().Be(6);
        pass.Succeeded.Should().Be(5, "the five bare tiles are tilled as asked");
        pass.Refused.Should().Be(1, "the crop tile is refused, not healed and not failed");
        pass.Failed.Should().Be(0);
        pass.Healed.Should().Be(0, "a pass that destroyed nothing has opened nothing");

        FarmhandForEachTargetResult crop = pass.Targets.Single(target => target.X == 62);
        crop.Outcome.Should().Be(FarmhandForEachTargetOutcome.Refused);
        crop.ReasonCode.Should().Be(
            "no_safe_clear:crop:scythe_crop",
            "the tile is her crop, and the refusal names the swing it weighed and refused so the next step is readable");
        crop.Healed.Should().BeNull("nothing was healed: the crop is still hers to harvest");
    }

    /// <summary>
    /// THE BOUND IS ONE CLEAR AND ONE RETRY. A tile that still refuses after a swing at the thing on it is reported as the
    /// refusal it is: clearing is not a search, and a pass that kept swinging would spend the actor's stamina on a guess.
    /// </summary>
    [Fact]
    public void ATileThatStillRefusesAfterOneClearIsRefusedAndNothingIsSweptTwice()
    {
        FarmhandForEachSource strip = Strip(60, 18, 1);
        var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
        var world = new TileWorld();
        world.Occupy(60, 18, "weed", "cut_weeds");
        world.KeepBlocking = true;

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_stuck", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled);

        pass.Targets.Single().Outcome.Should().Be(FarmhandForEachTargetOutcome.Failed);
        pass.Targets.Single().ReasonCode.Should().Be(
            "soil_not_diggable:still_blocked",
            "the retry's own refusal is reported, not the one the heal was answering");
        pass.Targets.Single().Healed.Should().Be(
            Healed("weed", "cut_weeds"),
            "the weed really was cut, so the row says what it removed even though the retry still refused");
        world.Dispatched.Select(target => target.ActionId).Should().Equal(
            new[] { "till_soil", "cut_weeds", "till_soil" },
            "exactly one clear and one retry, however the retry ends");
    }

    /// <summary>
    /// AN OCCUPANT NO DECLARATION NAMES IS REFUSED BY NAME, never guessed at and never cleared. `bush` is the case that
    /// matters: `harvest_bush` HARVES a bush, it does not remove one, so it declares no `Clears` - and the honest answer is
    /// the one that tells the caller there is nothing published to swing at.
    /// </summary>
    [Fact]
    public void AnOccupantNoPublishedActionClearsIsRefusedByName()
    {
        FarmhandForEachSource strip = Strip(60, 18, 1);
        var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
        var world = new TileWorld();
        world.Occupy(60, 18, "bush", clearer: null);

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_bush", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled);

        pass.Targets.Single().Outcome.Should().Be(FarmhandForEachTargetOutcome.Refused);
        pass.Targets.Single().ReasonCode.Should().Be(
            FarmhandForEachHealing.NoPublishedActionClears + ":bush",
            "nothing published removes a bush, and that is a fact about the catalogue rather than about the hoe");
        world.Dispatched.Should().ContainSingle("nothing is swung at a tile no declaration names");
    }

    /// <summary>
    /// A ROW THAT ALREADY SWUNG THE RIGHT TOOL KEEPS ITS OWN REASON. `break_rock` on a stone is the action that removes
    /// one, so "clear it first" would be the same refusal twice - and its own receipt is the thing to report.
    /// </summary>
    [Fact]
    public void ARowThatAlreadyDispatchedTheActionThatClearsItsOccupantKeepsItsOwnRefusal()
    {
        FarmhandForEachSource strip = Strip(60, 18, 1);
        var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep("break_rock")));
        var world = new TileWorld();
        world.Occupy(60, 18, "stone", "break_rock");
        world.ClearRefusal = "tool_level_insufficient";

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_stone", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled);

        pass.Targets.Single().ReasonCode.Should().Be(
            "tool_level_insufficient",
            "the action that removes a stone was the one asked for, so its own receipt is the answer");
        pass.Targets.Single().Healed.Should().BeNull();
        world.Dispatched.Should().ContainSingle("a second swing at the same tile is not a heal");
    }

    /// <summary>
    /// A CLEAR THAT DID NOT HAPPEN IS THE ANSWER. Its own receipt travels verbatim - the reason names the tool or the
    /// argument the clearing action needs - instead of being folded into the refusal it was meant to fix.
    /// </summary>
    [Fact]
    public void AClearThatItsOwnAdmissionRejectedReportsThatReceipt()
    {
        FarmhandForEachSource strip = Strip(60, 18, 1);
        var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
        var world = new TileWorld();
        world.Occupy(60, 18, "weed", "cut_weeds");
        world.ClearRefusal = "basic_scythe_not_equipped";

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(loop, "pass_notool", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled);

        FarmhandForEachTargetResult row = pass.Targets.Single();
        row.Target!.ActionId.Should().Be("cut_weeds", "the action that actually ran is the one whose receipt this is");
        row.Outcome.Should().Be(FarmhandForEachTargetOutcome.Failed);
        row.ReasonCode.Should().Be("basic_scythe_not_equipped", "the required tool is named by the action that needs it");
        row.Healed.Should().BeNull();
    }

    /// <summary>
    /// STOP IS CONSULTED BETWEEN THE TWO EFFECTS. The clear is a native swing of its own, so a STOP that arrives after the
    /// requested action was refused stops the pass before the swing - and the row says so.
    /// </summary>
    [Fact]
    public void StopBetweenTheRefusalAndTheClearEndsThePassWithoutSwinging()
    {
        FarmhandForEachSource strip = Strip(60, 18, 2);
        var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));
        var world = new TileWorld();
        world.Occupy(60, 18, "weed", "cut_weeds");

        FarmhandForEachPassResult pass = FarmhandForEachExpansion.Expand(
            loop,
            "pass_stop",
            world.Rows(strip),
            world.Dispatch,
            () => world.Dispatched.Count > 0,
            world.IsEnabled);

        pass.Stopped.Should().BeTrue();
        pass.Targets[0].Outcome.Should().Be(FarmhandForEachTargetOutcome.Stopped);
        world.Dispatched.Should().ContainSingle("the pass stops before the clearing swing, not after it");
    }

    /// <summary>
    /// THE GATE. Population: every occupant/action pair the catalogue's own `Clears` declarations name, against every
    /// action that declares a `TargetFamily`. Property: a tile occupied by that occupant and requested for that action is
    /// HEALED by the declared clearing action - never skipped, never left to the caller.
    ///
    /// <para>
    /// The population is derived from <see cref="FarmhandActionCatalog.Registrations"/>, so a new `Clears` declaration is
    /// covered the moment it is written and a renamed one fails by name. The three exemptions are catalogue facts, not
    /// convenience: the pair's own clearing action is not "healed" (it is the row's own attempt), an action that is
    /// ITSELF a clearer of the occupant keeps its own refusal, and a DESTRUCTIVE declaration is the other gate's
    /// population - <see cref="NoPassDispatchesADestructiveClearingAction"/> asserts the opposite about exactly those.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryDeclaredClearingActionIsReachedByAPassInsteadOfSkippingTheTile()
    {
        var failures = new List<string>();
        int examined = 0;
        foreach ((string occupant, string clearingAction, bool destructive) in DeclaredClearers())
        {
            if (destructive) continue;
            foreach (string requestedAction in TargetFamilyActionIds())
            {
                if (string.Equals(requestedAction, clearingAction, StringComparison.Ordinal)) continue;
                if (FarmhandForEachHealing.DeclaredClearersOf(occupant)
                    .Any(offer => string.Equals(offer.ActionId, requestedAction, StringComparison.Ordinal))) continue;
                examined += 1;

                FarmhandForEachSource strip = Strip(60, 18, 1);
                var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep(requestedAction)));
                var world = new TileWorld();
                world.Occupy(60, 18, occupant, clearingAction);
                world.IsEnabled = actionId => string.Equals(actionId, clearingAction, StringComparison.Ordinal);

                FarmhandForEachTargetResult row = FarmhandForEachExpansion
                    .Expand(loop, "pass_gate", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled)
                    .Targets.Single();
                if (row.Outcome == FarmhandForEachTargetOutcome.Succeeded && row.Healed == Healed(occupant, clearingAction)) continue;
                failures.Add(
                    $"clears_declared_but_never_used:{occupant}:{clearingAction} (requested {requestedAction} answered "
                    + $"{row.Outcome}/{row.ReasonCode ?? "no_reason"}/{row.Healed ?? "not_healed"})");
            }
        }

        examined.Should().BeGreaterThan(0, "the catalogue declares clearing actions, so the population is never empty");
        failures.Should().BeEmpty(
            $"every declared clearing action must be reachable from a pass; examined {examined} occupant/action pairs");
    }

    /// <summary>
    /// THE GATE OVER THE DESTRUCTIVE DECLARATIONS. Population: every occupant/action pair the catalogue marks
    /// `Destructive`, derived from the registrations. Property: NO PASS MAY DISPATCH A DESTRUCTIVE CLEARING ACTION - a
    /// tile carrying that occupant and requested for any other action answers `no_safe_clear:&lt;occupant&gt;:&lt;action&gt;`,
    /// and the occupant is still standing afterwards.
    ///
    /// <para>
    /// This is the half that was missing when `scythe_crop` reached her own crop: the heal read "what clears this" and
    /// never asked "and what does that cost her". The population is the declarations' own flag, so the next destructive
    /// row - or a row corrected to `destructive: true` - is covered without touching this test, and a pass that dispatches
    /// one fails BY NAME.
    /// </para>
    /// </summary>
    [Fact]
    public void NoPassDispatchesADestructiveClearingAction()
    {
        var failures = new List<string>();
        int examined = 0;
        foreach ((string occupant, string clearingAction, bool destructive) in DeclaredClearers())
        {
            if (!destructive) continue;
            foreach (string requestedAction in TargetFamilyActionIds())
            {
                if (string.Equals(requestedAction, clearingAction, StringComparison.Ordinal)) continue;
                if (FarmhandForEachHealing.DeclaredClearersOf(occupant)
                    .Any(offer => string.Equals(offer.ActionId, requestedAction, StringComparison.Ordinal))) continue;
                examined += 1;

                FarmhandForEachSource strip = Strip(60, 18, 1);
                var loop = new FarmhandForEachLoop(strip, null, new FarmhandForEachEffect(new FarmhandForEachStep(requestedAction)));
                var world = new TileWorld();
                world.Occupy(60, 18, occupant, clearingAction);

                FarmhandForEachTargetResult row = FarmhandForEachExpansion
                    .Expand(loop, "pass_destructive", world.Rows(strip), world.Dispatch, () => false, world.IsEnabled)
                    .Targets.Single();
                bool dispatched = world.Dispatched.Any(target => string.Equals(target.ActionId, clearingAction, StringComparison.Ordinal));
                bool standing = world.Carries(60, 18);
                string expected = FarmhandForEachHealing.NoSafeClearReason(occupant, clearingAction);
                if (!dispatched && row.Outcome == FarmhandForEachTargetOutcome.Refused
                    && string.Equals(row.ReasonCode, expected, StringComparison.Ordinal) && row.Healed is null && standing) continue;
                failures.Add(
                    $"destructive_clear_dispatched:{occupant}:{clearingAction} (requested {requestedAction} answered "
                    + $"{row.Outcome}/{row.ReasonCode ?? "no_reason"}/{row.Healed ?? "not_healed"}; "
                    + $"dispatched={dispatched}; stillStanding={standing})");
            }
        }

        examined.Should().BeGreaterThan(0, "the catalogue declares destructive clearing actions, so the population is never empty");
        failures.Should().BeEmpty(
            $"no pass may dispatch a destructive clearing action; examined {examined} occupant/action pairs");
    }

    /// <summary>
    /// Every occupant/action pair the catalogue declares, derived from the registrations and not from a list, with the
    /// declaration's own answer about whether the swing destroys what the player put there.
    /// </summary>
    private static IEnumerable<(string Occupant, string ClearingAction, bool Destructive)> DeclaredClearers() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.Clears is { Occupants.Count: > 0 })
            .SelectMany(registration => registration.Descriptor!.Clears!.Occupants
                .Select(occupant => (Occupant: occupant, ClearingAction: registration.ActionId, Destructive: registration.Descriptor!.Clears!.Destructive)));

    /// <summary>Every action that declares a `TargetFamily`: the actions a per-tile loop can be written for.</summary>
    private static IEnumerable<string> TargetFamilyActionIds() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.TargetFamily is { Length: > 0 })
            .Select(registration => registration.ActionId);

    /// <summary>
    /// The farm, as the pass reads it: what stands on each tile, and the world's own answer about working one.
    ///
    /// It is the ONE stand-in in this file. The native body is what a headless test does not own, so the stand-in models
    /// exactly the fact the pass has to cope with - a tile that still carries something refuses the action asked of it, and
    /// the action the catalogue names removes it - and decides nothing else.
    /// </summary>
    private sealed class TileWorld
    {
        private readonly Dictionary<(int X, int Y), string> occupants = new();
        private readonly Dictionary<string, string?> clearerOf = new(StringComparer.Ordinal);
        private readonly HashSet<(int X, int Y)> cleared = new();
        private readonly HashSet<(int X, int Y)> stillBlocked = new();
        private long revision;

        internal List<FarmhandForEachTarget> Dispatched { get; } = new();

        /// <summary>Whether the tile keeps refusing the requested action even after the declared clearing action swung.</summary>
        internal bool KeepBlocking { get; set; }

        /// <summary>The reason the declared clearing action's own admission rejects the swing, when it does.</summary>
        internal string? ClearRefusal { get; set; }

        /// <summary>The live policy, as the pass asks it about a clearing action the caller never named.</summary>
        internal Func<string, bool> IsEnabled { get; set; } = _ => true;

        internal void Occupy(int x, int y, string occupant, string? clearer)
        {
            this.occupants[(x, y)] = occupant;
            this.clearerOf[occupant] = clearer;
        }

        /// <summary>Whether the tile still carries what was placed on it: a swing that never ran leaves it standing.</summary>
        internal bool Carries(int x, int y) => this.occupants.ContainsKey((x, y)) && !this.cleared.Contains((x, y));

        internal IEnumerable<FarmhandForEachRow> Rows(FarmhandForEachSource source) =>
            FarmhandForEachRules.AreaRows(source).Select(row => new FarmhandForEachRow(
                row.X,
                row.Y,
                row.LocalColumn,
                row.LocalRow,
                this.Fields(row.X, row.Y)));

        private Dictionary<string, FarmhandForEachValue> Fields(int x, int y) =>
            new(StringComparer.Ordinal)
            {
                ["kind"] = FarmhandForEachValue.Of(this.occupants.TryGetValue((x, y), out string? occupant) ? occupant : "empty_tillable"),
                [FarmhandForEachHealing.OccupantField] = FarmhandForEachValue.Of(
                    this.occupants.TryGetValue((x, y), out occupant) ? occupant : FarmhandForEachHealing.NoOccupant),
            };

        internal bool Dispatch(
            FarmhandForEachTarget target,
            string requestId,
            string executionId,
            out LocalExecutionReceipt receipt,
            out string reasonCode)
        {
            this.Dispatched.Add(target);
            reasonCode = "accepted";
            var tile = (target.X ?? -1, target.Y ?? -1);
            bool occupied = this.occupants.TryGetValue(tile, out string? occupant) && !this.cleared.Contains(tile);
            if (occupied)
            {
                bool isClearer = this.clearerOf.TryGetValue(occupant!, out string? clearer)
                    && string.Equals(clearer, target.ActionId, StringComparison.Ordinal);
                if (isClearer && this.ClearRefusal is { Length: > 0 } refusal)
                {
                    receipt = this.Receipt(executionId, requestId, ExecutionState.Rejected, refusal, null);
                    return true;
                }
                if (isClearer)
                {
                    this.cleared.Add(tile);
                    if (this.KeepBlocking) this.stillBlocked.Add(tile);
                    receipt = this.Receipt(executionId, requestId, ExecutionState.Succeeded, "occupant_cleared", $"occupant={occupant}");
                    return true;
                }
                receipt = this.Receipt(executionId, requestId, ExecutionState.Rejected, $"soil_not_diggable:occupied:{occupant}", null);
                return true;
            }
            if (this.stillBlocked.Contains(tile))
            {
                receipt = this.Receipt(executionId, requestId, ExecutionState.Rejected, "soil_not_diggable:still_blocked", null);
                return true;
            }
            receipt = this.Receipt(executionId, requestId, ExecutionState.Succeeded, "worked", null);
            return true;
        }

        private LocalExecutionReceipt Receipt(string executionId, string requestId, ExecutionState state, string reasonCode, string? evidence)
        {
            this.revision += 1;
            return new LocalExecutionReceipt(executionId, requestId, state, reasonCode, this.revision, evidence);
        }
    }
}
