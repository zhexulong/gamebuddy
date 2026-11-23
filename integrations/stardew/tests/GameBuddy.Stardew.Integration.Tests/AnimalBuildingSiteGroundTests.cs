using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What one animal-house footprint tile is to the site search: ground the farm already has, ground a published action
/// opens, or a wall.
///
/// <para>
/// MEASURED `round93` (2026-11-22): <c>eliminated=object=2332</c> of 5195 candidate origins. The search counted every
/// object on the farm as ground the house could not have - and on a farm most objects are weeds, stones and twig litter,
/// which <c>cut_weeds</c>, <c>break_rock</c> and <c>remove_placed_item</c> take away. A player sweeps a patch and builds
/// on it; the fixture required the patch to have been swept already. It is the fourth member of one family that night
/// (<c>free_footprints=0</c> counting the fixture's own soil, <c>tillable=no</c> asking the spawn-placement predicate, and
/// the <c>3x20</c> block accounting counting only ground that was already clear): each measured the CURRENT state and
/// called it the possible one.
/// </para>
///
/// <para>
/// THE VOCABULARY IS THE ALGORITHM'S OWN. What stands on a tile is <see cref="TileOccupancy.Of"/> and what clears it is
/// <see cref="ClearingActionSurface.ClearersOf"/> over <see cref="FarmhandActionCatalog.Registrations"/>, so this file
/// names no kind and no action of its own: the cases below drive the real catalogue through the real classifier, and a
/// row whose <c>Clears</c> declaration moves takes these cases with it.
/// </para>
///
/// <para>
/// THE POPULATIONS ARE KEPT APART because they are two different repairs. A weed, a stone, a twig or a clump is cleared by
/// swinging at it - positional, so a player opens a strip before building. An objects-layer <c>object</c> with its own
/// action (forage, a machine, a chest) is not a way through: `pickup_forage` finishes a row and needs THAT object as its
/// target, so a barn cannot be placed where a log would first have to be picked up one at a time. `TileOccupantKind`'s own
/// <c>Unclearable</c> table states that reason, and this file reads it rather than restating it.
/// </para>
/// </summary>
[Trait("kind", "animal-site-ground")]
public sealed class AnimalBuildingSiteGroundTests
{
    /// <summary>
    /// A weed is CLEARING, not a wall: the catalogue's own <c>cut_weeds</c> answers for it, and the clearing leaves the
    /// tile empty and placeable.
    /// </summary>
    [Fact]
    public void AWeedIsGroundAPublishedActionOpensAndTheClearingLeavesItEmpty()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        SeedFloorPathLookup();
        world.PlaceWeed(1, 0);
        Vector2 tile = new(1, 0);

        string? wall = ModEntry.PlaySessionAnimalFootprintWall(world.Farm, tile, out string occupant, out string clearer);

        wall.Should().BeNull("a weed is what a player sweeps away before building, and the catalogue publishes the swing");
        occupant.Should().Be(TileOccupantKind.Weed, "the word is the classifier's, not this file's");
        clearer.Should().Be("cut_weeds", "the clearer is the row whose `Clears` declaration names the weed");
        Clear(world.Farm, tile).Should().Be(1);
        TileOccupancy.Of(world.Farm, 1, 0).Should().Be(TileOccupantKind.None, "the clearing actually cleared the tile");
    }

    /// <summary>The same for the other two object-layer kinds a strip is made of: a stone and a twig.</summary>
    [Fact]
    public void AStoneAndATwigAreClearedByTheRowsThatDeclareThem()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        SeedFloorPathLookup();
        world.PlaceRock(1, 0, durability: 2);
        world.PlaceObjectAt(2, 0, "(O)450", name: "Twig", category: -999);

        string? stoneWall = ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(1, 0), out string stone, out string stoneClearer);
        string? twigWall = ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(2, 0), out string twig, out string twigClearer);

        stoneWall.Should().BeNull();
        stone.Should().Be(TileOccupantKind.Stone);
        stoneClearer.Should().Be("break_rock");
        twigWall.Should().BeNull();
        twig.Should().Be(TileOccupantKind.Twig);
        twigClearer.Should().Be("remove_placed_item", "the axe swing that declares the twig is the one that opens the tile");

        Dictionary<string, int> kinds = new(StringComparer.Ordinal);
        IEnumerable<Vector2> footprint = new[] { new Vector2(1, 0), new Vector2(2, 0) };
        int cleared = ModEntry.ClearPlaySessionAnimalFootprint(world.Farm, footprint, kinds, out string? failure);

        failure.Should().BeNull();
        cleared.Should().Be(2);
        kinds.Should().ContainKeys(TileOccupantKind.Stone, TileOccupantKind.Twig);
        TileOccupancy.Of(world.Farm, 1, 0).Should().Be(TileOccupantKind.None);
        TileOccupancy.Of(world.Farm, 2, 0).Should().Be(TileOccupantKind.None);
    }

    /// <summary>
    /// A clump is debris, and debris is what `clear_debris`/`break_resource_clump` declare. The whole clump goes, because
    /// half a clump is not a state the engine has.
    /// </summary>
    [Fact]
    public void AClumpIsClearableAndItsWholeFootprintGoes()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        SeedFloorPathLookup();
        world.PlaceResourceClump(
            x: 1,
            y: 0,
            parentSheetIndex: StardewValley.TerrainFeatures.ResourceClump.boulderIndex,
            width: 2,
            height: 2);

        string? wall = ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(1, 0), out string occupant, out string clearer);

        wall.Should().BeNull("a boulder is debris a published action clears");
        occupant.Should().Be(TileOccupantKind.Boulder);
        clearer.Should().BeOneOf("clear_debris", "break_resource_clump");
        Dictionary<string, int> kinds = new(StringComparer.Ordinal);
        int cleared = ModEntry.ClearPlaySessionAnimalFootprint(world.Farm, new[] { new Vector2(1, 0) }, kinds, out string? failure);

        failure.Should().BeNull();
        cleared.Should().Be(1);
        world.Farm.resourceClumps.Should().BeEmpty("the clump is one thing, and its whole footprint left with it");
    }

    /// <summary>
    /// THE OTHER POPULATION, and it stays a wall: an object with its own action is not a way through. The refusal names the
    /// walls with the reason `TileOccupantKind` declares for them, so "nothing of ours removes this" and "nobody wrote it
    /// down" stay different answers.
    /// </summary>
    [Fact]
    public void AnObjectWithItsOwnActionIsAWallAndSaysWhy()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        SeedFloorPathLookup();
        world.PlaceForage(1, 0, "(O)18");

        string? wall = ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(1, 0), out string occupant, out string clearer);

        wall.Should().Be(TileOccupantKind.OtherObject);
        occupant.Should().Be(TileOccupantKind.OtherObject);
        clearer.Should().BeEmpty("nothing in this file may claim a clearer for an occupant the catalogue refuses to open");
        TileOccupantKind.UnclearableCode(occupant).Should().Be(
            "removal_is_not_a_way_through",
            "the reason a forage cannot be built over is the vocabulary's own: its action addresses IT, not the tile");
        ClearingActionSurface.ClearersOf(occupant, FarmhandActionCatalog.Registrations).Should().BeEmpty();
    }

    /// <summary>
    /// A TILE THE FIXTURE WILL NOT DESTROY. A grassy tuft's only published swing is `cut_grass`, declared destructive
    /// because a tuft can be feed the player planted - so the search refuses the candidate BY NAME with the swing it
    /// weighed (`no_safe_clear:grass:cut_grass`) instead of scything the world to fit a house.
    /// </summary>
    [Fact]
    public void ATileWhoseOnlySwingWouldDestroyItIsRefusedByName()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        SeedFloorPathLookup();
        world.PlaceGrass(1, 0);

        ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(1, 0), out string occupant, out _)
            .Should().Be(
                $"{ModEntry.PlaySessionAnimalDestructiveClearRefusal}:{TileOccupantKind.Grass}:cut_grass",
                "the refusal names the occupant and the swing it weighed, so the next reader knows what was not spent");
        occupant.Should().Be(TileOccupantKind.Grass);
        TileOccupancy.Of(world.Farm, 1, 0).Should().Be(TileOccupantKind.Grass, "nothing touched the tuft");
    }

    /// <summary>
    /// A CLEARING THAT DOES NOT COME FREE IS NAMED. A twig on top of a sown tile comes out of the object layer and leaves
    /// the crop behind - so the tile is still occupied, and the reading says what is left (`twig@0,0:-&gt;crop`) instead of
    /// handing the placement a tile the house would stand in the middle of.
    /// </summary>
    [Fact]
    public void AClearingThatLeavesTheTileOccupiedIsNamedWithWhatIsLeft()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        SeedFloorPathLookup();
        world.PlaceObjectAt(1, 0, "(O)450", name: "Twig", category: -999);
        world.PlaceDeadCrop(1, 0);

        ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(1, 0), out string occupant, out _)
            .Should().BeNull("the classifier answers for the layer that is asked first, which is the object");
        occupant.Should().Be(TileOccupantKind.Twig);

        Dictionary<string, int> kinds = new(StringComparer.Ordinal);
        int cleared = ModEntry.ClearPlaySessionAnimalFootprint(world.Farm, new[] { new Vector2(1, 0) }, kinds, out string? failure);

        cleared.Should().Be(0, "a clearing that failed cleared nothing");
        failure.Should().Be(
            $"{TileOccupantKind.Twig}@1,0:->{TileOccupantKind.Crop}",
            "the report names the occupant that was removed and what the tile still holds");
        TileOccupancy.Of(world.Farm, 1, 0).Should().Be(TileOccupantKind.Crop, "the object is gone and the crop is not");
    }

    /// <summary>
    /// AN EMPTY TILE IS STILL JUDGED BY THE MAP. The classifier is not "nothing is here, so build": water, a cliff and a
    /// building all answer in their own words, and the two map rules are the engine's own predicates rather than a second
    /// copy of them.
    /// </summary>
    [Fact]
    public void AnEmptyTileStillAnswersForTheMapAndForBuildings()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        SeedFloorPathLookup();
        world.MakeDiggable(1, 0);
        world.MakeWater(2, 0);
        world.MakeWall(3, 0);

        ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(1, 0), out string openOccupant, out string openClearer)
            .Should().BeNull("open ground needs no clearing");
        openOccupant.Should().Be(TileOccupantKind.None);
        openClearer.Should().BeEmpty();
        ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(2, 0), out _, out _)
            .Should().Be(ModEntry.PlaySessionAnimalNotPlaceableRefusal, "water is not ground a house stands on");
        ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(3, 0), out _, out _)
            .Should().Be(ModEntry.PlaySessionAnimalNotPlaceableRefusal, "a Buildings-layer wall is the map's own refusal");
        ModEntry.PlaySessionAnimalFootprintWall(world.Farm, new Vector2(16, 0), out _, out _)
            .Should().Be(ModEntry.PlaySessionAnimalOffMapRefusal, "a tile the map does not hold names the map, not the ground");
    }

    /// <summary>
    /// `Object.isPassable` asks `IsFloorPathItem` (Object.cs:6075/:6082), which builds its lookup from
    /// `Game1.floorPathData` - a cache filled at startup, null in a headless process. Seed it empty for the same reason
    /// `TileOccupantVocabularyTests` does: this world declares no flooring, and an uninitialized cache makes every collision
    /// read throw.
    /// </summary>
    internal static void SeedFloorPathLookup() =>
        Game1.floorPathData ??= new Dictionary<string, StardewValley.GameData.FloorsAndPaths.FloorPathData>(StringComparer.Ordinal);

    private static int Clear(GameLocation farm, Vector2 tile)
    {
        Dictionary<string, int> kinds = new(StringComparer.Ordinal);
        int cleared = ModEntry.ClearPlaySessionAnimalFootprint(farm, new[] { tile }, kinds, out string? failure);
        failure.Should().BeNull();
        return cleared;
    }
}
