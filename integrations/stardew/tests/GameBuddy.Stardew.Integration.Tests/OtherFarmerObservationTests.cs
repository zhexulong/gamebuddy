using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The humans in a co-op session, as the observation publishes them.
///
/// <para>
/// THE FACT THE OBSERVATION DID NOT HAVE. Every entity family published a thing - crops, weeds, objects, chests, animals,
/// villagers, buildings, ground - and none of them was the other PLAYER. `Game1.otherFarmers` was never read, so a
/// companion standing beside a human at (33,17), facing left with a watering can, had no published fact that said a person
/// was there at all.
/// </para>
///
/// <para>
/// These cases drive the SHIPPED `DiscoverOtherFarmers` through <see cref="TargetFamilyCompletenessTests.TargetFamilyWorld"/>
/// with a second real <see cref="Farmer"/> in `Game1.otherFarmers`, so what they assert is the projection the Mod
/// publishes rather than a re-implementation of it. Each row member is an engine answer: the tile and map the farmer
/// stands on, `Name`, `FacingDirection`, `CurrentItem`, and the first of `UsingTool`/`isEmoting`/`IsSitting()`/
/// `isMoving()` that holds.
/// </para>
/// </summary>
public sealed class OtherFarmerObservationTests
{
    private const long ActorId = 1001;
    private const long OtherFarmerId = 1002;
    private const string OtherFarmerName = "Mika";

    [Fact]
    public void AFarmerStandingBesideHerIsPublishedWithTheFactsTheEngineAnswers()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceOtherFarmer(
            OtherFarmerName,
            x: 3,
            y: 2,
            id: OtherFarmerId,
            facing: 3,
            heldQualifiedItemId: "(O)24",
            heldDisplayName: "防风草");

        BridgeOtherFarmerTarget row = Single(world, out int omitted);

        row.Name.Should().Be(OtherFarmerName, "the row carries the other player's own character name");
        row.Location.Should().Be(world.Farm.NameOrUniqueName, "the row names the map the player was seen on");
        row.X.Should().Be(3, "the tile is the farmer's own `Tile`, one tile east of the actor");
        row.Y.Should().Be(2);
        row.Facing.Should().Be("left", "`FacingDirection` 3 is the engine's own word for left");
        row.HeldQualifiedItemId.Should().Be("(O)24", "`Farmer.CurrentItem` is what that player is holding right now");
        row.HeldDisplayName.Should().Be(
            ExecutionManager.RequireDisplayName("(O)24"),
            "the row names the held item through the one seam every sibling family names an item with, so this asserts "
            + "the row against that seam rather than against a second copy of the answer");
        row.Doing.Should().Be("idle", "all four of the engine's action predicates answered no, which is a measurement");
        omitted.Should().Be(0, "the only other farmer was published, so nothing was withheld");
    }

    [Fact]
    public void APlayerMidSwingIsPublishedAsUsingAToolRatherThanStandingStill()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        Farmer other = world.PlaceOtherFarmer(OtherFarmerName, x: 3, y: 2, id: OtherFarmerId);
        // `Farmer.UsingTool` is the engine's own flag for a body in the middle of a tool use (`BeginUsingTool` writes it),
        // and it is the first predicate the row reads: a farmer swinging an axe is not merely standing on a tile.
        other.UsingTool = true;

        Single(world, out _).Doing.Should().Be("using_tool");
    }

    [Fact]
    public void EmptyHandsArePublishedAsNoneRatherThanAsAbsent()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceOtherFarmer(OtherFarmerName, x: 3, y: 2, id: OtherFarmerId);

        BridgeOtherFarmerTarget row = Single(world, out _);

        // `none` is the wire's word for a MEASURED absence, so a reader can tell "this player's hands are empty" from "the
        // held item was not measured" - the distinction every `null`-means-unmeasured member in this protocol keeps.
        row.HeldQualifiedItemId.Should().Be("none");
        row.HeldDisplayName.Should().Be("none");
    }

    [Fact]
    public void ABodyWithNoFarmerAnimationStateSaysNotMeasuredRatherThanIdle()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceOtherFarmer(OtherFarmerName, x: 3, y: 2, id: OtherFarmerId, farmerSprite: false);

        // `Farmer.FarmerSprite` is a cast of `Character.Sprite`, so a body the engine holds no farmer animation for has no
        // action state to ask. The row says so instead of claiming a body that is not being simulated is standing still.
        Single(world, out _).Doing.Should().Be("not_measured");
    }

    [Fact]
    public void AnEngineFacingOutsideTheFourWordsIsPublishedAsNotMeasured()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceOtherFarmer(OtherFarmerName, x: 3, y: 2, id: OtherFarmerId, facing: 7);

        // Range boundary (CORRECT): the engine names four directions, and a value outside them is not translated into one
        // it names - `not_measured` is the honest answer for a direction this vocabulary has not met.
        Single(world, out _).Facing.Should().Be("not_measured");
    }

    [Fact]
    public void AFarmerTwentyTilesAwayOnTheSameMapIsPublishedWithItsTile()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        // Twenty tiles away on the SAME map: a person waving from across the farm. She is visible to whoever is watching
        // this screen, and the question this family answers is "who is on my map", which no reach radius answers.
        world.PlaceOtherFarmer(OtherFarmerName, x: 22, y: 2, id: OtherFarmerId);

        BridgeOtherFarmerTarget row = Single(world, out int omitted);

        row.Name.Should().Be(OtherFarmerName, "a person across the farm is still a person on this farm");
        row.X.Should().Be(22, "the row carries the tile she is actually standing on, however far that is from the actor");
        row.Y.Should().Be(2);
        row.Location.Should().Be(world.Farm.NameOrUniqueName, "and the map it belongs to, which is what the bound is now");
        omitted.Should().Be(0, "the only other farmer on this map was published");
    }

    [Fact]
    public void TheRowBudgetIsTheOnlyCapOnThisMapAndTheRowsPastItAreCounted()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        int placed = ExecutionManager.OtherFarmerLimit + 1;
        for (int index = 0; index < placed; index += 1)
            world.PlaceOtherFarmer($"Player{index}", x: 3 + index, y: 2, id: OtherFarmerId + index);

        IReadOnlyList<BridgeOtherFarmerTarget> rows = world.OtherFarmers(out int omitted);

        // Cardinality boundary (CORRECT): the budget is the family's own `maxItems`, not a window, so the map's players
        // are all candidates and exactly one row is the one the budget could not carry - the furthest, because the list is
        // ordered before it is trimmed.
        rows.Should().HaveCount(ExecutionManager.OtherFarmerLimit, "the cap is the wire's declared row budget");
        rows.Select(row => row.X).Should().NotContain(3 + placed - 1, "the cap costs the furthest player, never the nearest");
        omitted.Should().Be(1, "and the row it left out is counted, so the list never reads as the whole map");
    }

    [Fact]
    public void AFarmerOnAnotherMapIsWithheldAndCounted()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        Farmer other = world.PlaceOtherFarmer(OtherFarmerName, x: 3, y: 2, id: OtherFarmerId);
        var elsewhere = new GameLocation();
        other.currentLocation = elsewhere;

        IReadOnlyList<BridgeOtherFarmerTarget> rows = world.OtherFarmers(out int omitted);

        rows.Should().BeEmpty("only the actor's own map is read, which is the whole bound this family has");
        omitted.Should().Be(1, "another human player is on no row, so the count is what says they exist");
    }

    [Fact]
    public void TheLocalPlayerIsNeverASubjectOfTheFamily()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        // The engine's own body update walks `otherFarmers` and skips the local id (Game1.cs:9471-9475); a session that
        // somehow holds a self entry must not publish her body twice.
        world.PlaceOtherFarmer(world.Actor.Name ?? string.Empty, x: 2, y: 3, id: ActorId);

        IReadOnlyList<BridgeOtherFarmerTarget> rows = world.OtherFarmers(out int omitted);

        rows.Should().BeEmpty("the local actor's body is the snapshot's own tile, tool and stamina - not a second row");
        omitted.Should().Be(0, "a self entry is not a farmer the family withheld; it is not its subject at all");
    }

    [Fact]
    public void TheNearestFarmerIsPublishedFirstSoTheCapNeverCostsTheOneBesideHer()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceOtherFarmer("Far", x: 7, y: 2, id: OtherFarmerId + 1);
        world.PlaceOtherFarmer("Near", x: 3, y: 2, id: OtherFarmerId);

        IReadOnlyList<BridgeOtherFarmerTarget> rows = world.OtherFarmers(out int omitted);

        rows.Should().HaveCount(2, "both farmers are on this map");
        rows[0].Name.Should().Be("Near", "the row order is the actor's: nearest first, like every other discovery family");
        omitted.Should().Be(0);
    }

    /// <summary>
    /// One row, and the assertion that the fixture produced exactly one: a case that passed on an empty list would be a
    /// case about nothing.
    /// </summary>
    private static BridgeOtherFarmerTarget Single(
        TargetFamilyCompletenessTests.TargetFamilyWorld world,
        out int omitted)
    {
        IReadOnlyList<BridgeOtherFarmerTarget> rows = world.OtherFarmers(out omitted);
        rows.Should().ContainSingle("the fixture puts exactly one other farmer on the actor's map");
        return rows[0];
    }
}
