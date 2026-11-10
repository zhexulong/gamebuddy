using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A `clear_step_blocked` refusal is a refusal, not a dead end: the caller has walked to the blocker, been told the
/// route is still shut, and must be able to decide what to do about it in its NEXT plan rather than spend another
/// observation round-trip finding out what stands there.
///
/// <para>
/// Measured `round40` attempt 2: 287 successful actions and one failure in the whole run - `move_to_tile` refusing at
/// `(40,9)` with `clear_step_blocked`. One weed, four-way pathfinding refused, and nothing in the receipt said what
/// stood there or which of the Mod's own actions removes it, so the Agent abandoned the tile. The policy stays: the
/// walk never clears anything, because swinging costs a tool and stamina and which rock to remove is the caller's
/// question. What changes is that the caller is now told enough to answer it.
/// </para>
///
/// <para>
/// The world is <see cref="ClearStepMoveTests.CorridorHarness"/>: a 16x16 map walled on every row but y=3, an actor at
/// the west end of that corridor, and one occupant blocking it. The cells asserted on are the receipt's OWN words, so
/// the fixture never states the answer - the projection and the derivation do.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the derivation pins read the published surface and the cost vocabulary, while the refusal pins drive the real arrival path in a headless world; keeping both in one file keeps each pin beside the behaviour it protects.
[Collection(HeadlessGameWorld.Collection)]
public sealed class ClearStepBlockerNamingTests
{
    /// <summary>
    /// The NON-DESTRUCTIVE case, which must not regress: the refusal still answers with the action that clears it - now
    /// with the PRICE of that dispatch beside it, and with the other branch (`detour_steps`) so the caller can weigh the
    /// two.
    /// </summary>
    [Fact]
    public void AWeedOnTheOnlyRouteIsNamedWithTheActionThatClearsIt()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceWeed(6, 3);

        (string code, string? evidence) = harness.Arrive(blocker: (6, 3), fromX: 5, fromY: 3);

        code.Should().Be(StardewBodyController.ClearStepBlockedReasonCode, "the walk refused, and it says so by name");
        evidence.Should().NotBeNull();
        evidence!.Should().Contain("blocker_occupant=weed",
            "the engine's own name for the occupant, not a word the costing table invented");
        evidence.Should().Contain("clears_with=cut_weeds",
            "the caller must be able to clear it in the next plan without another observation round-trip");
        evidence.Should().Contain("stamina:0,tool:scythe,turns:1",
            "and what that dispatch costs: a scythe swing charges no stamina (MeleeWeapon has no charge) and takes one turn");
        evidence.Should().Contain("detour_steps=none",
            "one corridor has no way around it, and the refusal has to say that rather than leave it to be guessed");
        evidence.Should().Contain("blocker_target=weed_",
            "the id the frame published for that weed, so the clearing action can be addressed by it");
        evidence.Should().Contain("stand_at=5,3", "and where she must stand to swing at it");
    }

    /// <summary>
    /// (a) THE shape the operator met in play: a bush is in the way. It blocks a body, no priced tool removes it, and
    /// `harvest_bush` is a HARVEST that declares no `Clears` - so the refusal must say there is no action for it and
    /// offer the other branch, instead of describing the tile as a wall (`blocked_by=none`) or advertising a harvest as
    /// a way through.
    /// </summary>
    [Fact]
    public void ABushOnTheOnlyRouteIsNamedAsHavingNoPublishedActionAndOffersTheWalkInstead()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceBush(6, 3);

        (string code, string? evidence) = harness.Refuse(fromX: 2, fromY: 3);

        code.Should().Be(StardewBodyController.NoNativePathReasonCode);
        evidence.Should().NotBeNull();
        evidence!.Should().Contain("blocker_occupant=bush",
            "the thing actually in the way, named from the engine's large terrain feature");
        evidence.Should().Contain("clears_with=no_published_action_clears:bush",
            "harvest_bush harvests a bush rather than clearing a path through one, so nothing we publish removes it");
        evidence.Should().NotContain("clears_with=harvest_bush",
            "a harvest advertised as a way through would be advice the action cannot honour");
        evidence.Should().Contain("reachable=5,3;detour_steps=3",
            "the other branch, measured: three steps of walking reach 5,3, and that is as close as she can get");
    }

    /// <summary>
    /// (c) The id exists only for what a frame published. A boulder no tool in her pack can break is priced by the
    /// clearing search and never appears in `debrisTargets`, so the refusal must say so rather than fabricate a hash.
    /// </summary>
    [Fact]
    public void ABlockerTheFrameNeverPublishedSaysSoAndNeverInventsAnId()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceRock(6, 3);

        (string code, string? evidence) = harness.Arrive(blocker: (6, 3), fromX: 5, fromY: 3);

        code.Should().Be(StardewBodyController.ClearStepBlockedReasonCode);
        evidence!.Should().Contain("blocker_occupant=quarry_boulder",
            "the engine's own constant for resource clump 148 (ResourceClump.quarryBoulderIndex)");
        evidence.Should().Contain("blocker_target=blocker_not_published",
            "this actor owns no pickaxe, so `debrisTargets` publishes no row for it and there is no id to hand out");
        evidence.Should().NotContain("blocker_target=debris_",
            "a fabricated id would be an identity the caller can never satisfy");
    }

    /// <summary>
    /// (a) and (c) on the formatter the refusal itself calls: the occupant's engine name, the action whose declared kind
    /// accepts it, and the id the frame published - or the honest absence of one.
    ///
    /// <para>
    /// Driven straight through <see cref="StardewBodyController.DescribeBlocker"/> rather than through a walk, because the
    /// walk's reachability is a question about the map while this is a question about one tile. The refusal-level pins
    /// above prove the words reach a receipt; these prove the words are the right ones without a route having to resolve
    /// first.
    /// </para>
    /// </summary>
    [Fact]
    public void TheBlockerFactsNameTheOccupantTheActionAndThePublishedId()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceWeed(6, 3);

        harness.BlindController().DescribeBlocker(harness.Actor, (6, 3)).Should().Be(
            $"blocker_occupant=weed@6,3;clears_with=cut_weeds(stamina:0,tool:scythe,turns:1);blocker_target={harness.WeedTargetId(6, 3)}",
            "the weed's own engine name and tile, the one action that declares it clears weeds with that dispatch's price, and the id the frame carries");
    }

    [Fact]
    public void TheBlockerFactsWithholdAnIdNoFrameCouldCarry()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceRock(6, 3);

        harness.BlindController().DescribeBlocker(harness.Actor, (6, 3)).Should().Be(
            "blocker_occupant=quarry_boulder@6,3;clears_with=clear_debris(stamina:4,tool:target_requirement,turns:1),break_resource_clump(stamina:4,tool:target_requirement,turns:1);blocker_target=blocker_not_published",
            "both clump actions declare it, at the engine's own pickaxe charge (2 * (power + 1) - MiningLevel * 0.1 = 4 at a bare pickaxe and Mining 0), and neither can address it by an id this frame never published");
    }

    /// <summary>
    /// (b) Nothing of ours removes it. The derivation reads the published surface, so a surface that carries no action
    /// for the occupant answers with the absence instead of leaving the caller to guess at an action id.
    ///
    /// <para>
    /// The surface is supplied rather than synthesised into a world because every occupant the clearing search prices
    /// in the shipped catalog has a published clearer: no reachable world state produces this branch. A world invented
    /// to reach it would be a second, hand-written kind-to-action table - the very thing this derivation replaces.
    /// </para>
    /// </summary>
    [Fact]
    public void AnOccupantNoPublishedActionClearsSaysSo()
    {
        FarmhandActionRegistration[] surfaceWithoutCutWeeds = FarmhandActionCatalog.Registrations
            .Where(registration => registration.ActionId != "cut_weeds")
            .ToArray();

        ClearingActionSurface.ClearersOf("weed", surfaceWithoutCutWeeds).Should().BeEmpty();

        string described = ClearingEvidence.DescribeBlocker(
            "weed",
            (6, 3),
            targetId: null,
            clearers: ClearingActionSurface.ClearersOf("weed", surfaceWithoutCutWeeds),
            staminaCharge: 0,
            detourFacts: null);
        described.Should().Contain("clears_with=no_published_action_clears:weed",
            "the code alphabet the wire accepts, and the occupant the caller can name back to us");
    }

    /// <summary>
    /// The bush, driven straight through the formatter: no price is quoted for a branch that does not exist, and the
    /// walk the caller DOES have is offered in the same breath.
    /// </summary>
    [Fact]
    public void ABushQuotesNoClearPriceAndTheWalkInstead()
    {
        string described = ClearingEvidence.DescribeBlocker(
            "bush",
            (6, 3),
            targetId: null,
            clearers: ClearingActionSurface.ClearersOf("bush", FarmhandActionCatalog.Registrations),
            staminaCharge: null,
            detourFacts: ClearingEvidence.DescribeDetour((5, 3), 3));

        described.Should().Be(
            "blocker_occupant=bush@6,3;clears_with=no_published_action_clears:bush;blocker_target=blocker_not_published;reachable=5,3;detour_steps=3",
            "nothing to swing at, no invented price for it, and the measured walk in its place");
    }

    /// <summary>
    /// A branch that was never offered is stated as `none`, not as a zero: `detour_steps=0` would read as "you are
    /// already there", which is the opposite of what an enclosed route means.
    /// </summary>
    [Fact]
    public void NoReachableTileIsSaidInWords()
    {
        ClearingEvidence.DescribeDetour(null, null).Should().Be("detour_steps=none");
        ClearingEvidence.DescribeDetour((5, 3), null).Should().Be("detour_steps=none");
    }

    /// <summary>
    /// The derivation's positive population, read from the surface the Mod actually publishes: each occupant a
    /// clearing search can price is cleared by the action this test expects, and nothing is named by a table kept
    /// anywhere else.
    /// </summary>
    [Theory]
    [InlineData("weed", "cut_weeds")]
    [InlineData("stone", "break_rock")]
    [InlineData("grass", "cut_grass")]
    [InlineData("tree", "chop_tree")]
    [InlineData("quarry_boulder", "clear_debris")]
    [InlineData("stump", "clear_debris")]
    public void ThePublishedSurfaceNamesTheActionThatClearsEachOccupant(string occupant, string actionId)
    {
        ClearingActionSurface.ClearersOf(occupant, FarmhandActionCatalog.Registrations)
            .Select(offer => offer.ActionId)
            .Should().Contain(actionId);
    }

    /// <summary>
    /// A gate over the catalog itself, not over today's rows: a `Clears` declaration that does not say what the swing
    /// costs cannot be weighed against walking around, and "we never got round to it" is exactly how a price becomes a
    /// guess. `turns` is one everywhere, because a clearing action IS one dispatched action.
    /// </summary>
    [Fact]
    public void EveryClearingDeclarationStatesWhatTheSwingCosts()
    {
        FarmhandActionRegistration[] declaring = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.Clears is not null)
            .ToArray();

        declaring.Should().NotBeEmpty("the population must not be empty, or this gate agrees with itself");
        foreach (FarmhandActionRegistration registration in declaring)
        {
            FarmhandClearingCost cost = registration.Descriptor!.Clears!.Cost;
            cost.Tool.Should().NotBeNullOrWhiteSpace($"{registration.ActionId} declares a clearing without naming the tool it swings");
            cost.Turns.Should().Be(1, $"{registration.ActionId} is one dispatched action, so its clear costs one turn");
            registration.Descriptor!.Clears!.Occupants.Should().NotBeEmpty(
                $"{registration.ActionId} declares a clearing price for no occupant at all");
        }
    }

    /// <summary>
    /// A gate, not an assertion about today's rows: an action that declares what it clears must also declare the
    /// snapshot family that publishes those rows, or the caller is told to use an action with nothing to aim it at.
    /// The population is the catalog itself, and a new `Clears` declaration without a `TargetFamily` fails by name.
    /// </summary>
    [Fact]
    public void EveryOccupantDeclarationNamesTheFamilyThatPublishesIt()
    {
        string[] offenders = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.Clears is { Occupants.Count: > 0 }
                && string.IsNullOrEmpty(registration.Descriptor.TargetFamily))
            .Select(registration => registration.ActionId)
            .ToArray();

        offenders.Should().BeEmpty("a clearer that publishes no target family offers the caller an action it cannot aim");
    }
}
