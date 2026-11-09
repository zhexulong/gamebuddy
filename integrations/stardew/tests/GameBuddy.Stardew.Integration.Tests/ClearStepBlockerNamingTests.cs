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
public sealed class ClearStepBlockerNamingTests
{
    /// <summary>
    /// (a) A weed on the only route: the refusal names the WEED, the action of ours whose declared kind accepts it, the
    /// id the frame published for it, and the tile the caller must stand on to clear it.
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
        evidence.Should().Contain("blocker_target=weed_",
            "the id the frame published for that weed, so the clearing action can be addressed by it");
        evidence.Should().Contain("stand_at=5,3", "and where she must stand to swing at it");
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
            $"blocker_occupant=weed;clears_with=cut_weeds;blocker_target={harness.WeedTargetId(6, 3)}",
            "the weed's own engine name, the one action that declares it clears weeds, and the id the frame carries");
    }

    [Fact]
    public void TheBlockerFactsWithholdAnIdNoFrameCouldCarry()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceRock(6, 3);

        harness.BlindController().DescribeBlocker(harness.Actor, (6, 3)).Should().Be(
            "blocker_occupant=quarry_boulder;clears_with=clear_debris,break_resource_clump;blocker_target=blocker_not_published",
            "both clump actions declare it, and neither can address it by an id this frame never published");
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

        ClearingActionSurface.ActionsThatClear("weed", surfaceWithoutCutWeeds).Should().BeEmpty();

        string described = ClearingEvidence.DescribeBlocker("weed", targetId: null, ClearingActionSurface.ActionsThatClear("weed", surfaceWithoutCutWeeds));
        described.Should().Contain("clears_with=no_published_action_clears:weed",
            "the code alphabet the wire accepts, and the occupant the caller can name back to us");
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
        ClearingActionSurface.ActionsThatClear(occupant, FarmhandActionCatalog.Registrations)
            .Should().Contain(actionId);
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
            .Where(registration => registration.Descriptor?.Clears is { Count: > 0 }
                && string.IsNullOrEmpty(registration.Descriptor.TargetFamily))
            .Select(registration => registration.ActionId)
            .ToArray();

        offenders.Should().BeEmpty("a clearer that publishes no target family offers the caller an action it cannot aim");
    }
}
