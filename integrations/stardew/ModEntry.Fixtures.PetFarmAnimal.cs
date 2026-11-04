using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>The one coop animal this fixture adopts. A coop animal, because `pet_farm_animal` reads
    /// <c>location.animals</c> and a coop is the smallest AnimalHouse the game ships.</summary>
    private const string PetFarmAnimalFixtureAnimalType = "White Chicken";

    /// <summary>
    /// pet_farm_animal pre-attachment Given: one unpetted coop animal, indoors, with the actor standing in the
    /// ring around it.
    ///
    /// <para>
    /// Only the Given is established. The pet itself, the +15 friendship, the happiness, the engine's
    /// <c>wasPet</c> marker and the receipt are <see cref="ExecutionManager"/>'s
    /// (farmhandexecutioncontroller.machinesanimalsitemsactions.cs), and it re-resolves the animal from
    /// <c>location.animals</c> on the game thread and measures reach against the animal's LIVE tile.
    /// </para>
    ///
    /// <para>
    /// ONE animal, not a stocked house: <c>DiscoverFarmAnimalPetTargets</c> filters the engine's own
    /// <c>wasPet</c> marker, so "the petted animal left the published family" is only unambiguous when the
    /// family had exactly one member. A Deluxe Coop full of animals (what <c>SetupBigFarm</c> builds) would
    /// leave the runner comparing opaque ids against a list of near-identical siblings.
    /// </para>
    ///
    /// <para>
    /// The coop is placed through the debug build entrypoint because a farm building is a world fact the save
    /// owns, not something an in-memory object can stand in for; <c>ForceBuild</c> is the engine's own
    /// placement path with its safety checks skipped, so this cannot fail on whatever the template's terrain
    /// happens to hold. The animal is then adopted by the house itself, which is what gives it its home, its
    /// position and its <c>animalsThatLiveHere</c> entry.
    /// </para>
    /// </summary>
    private void InstallNativeLocalPetFarmAnimalFixture(Farmer player)
    {
        Farm farm = Game1.getFarm();

        // Before 19:00 on purpose: `FarmAnimal.pet` answers a stationary animal with the `TryingToSleep`
        // dialogue after 19:00 (FarmAnimal.cs:703) instead of petting, and this action refuses that branch by
        // name. A save resumed at night would otherwise fail for the clock rather than for the action.
        Game1.timeOfDay = 1200;
        if (Game1.timeOfDay >= 1900)
            throw new InvalidOperationException("fixture_native_local_pet_farm_animal_clock_not_set");

        GameLocation? previousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("ForceBuild \"Coop\" 4 9", null))
                throw new InvalidOperationException("fixture_native_local_pet_farm_animal_coop_build_unavailable");
        }
        finally
        {
            Game1.currentLocation = previousLocation;
        }

        if (farm.buildings.LastOrDefault(building =>
                string.Equals(building.buildingType.Value, "Coop", StringComparison.Ordinal)) is not Building coop)
            throw new InvalidOperationException("fixture_native_local_pet_farm_animal_coop_missing");
        if (coop.GetIndoors() is not AnimalHouse house)
            throw new InvalidOperationException("fixture_native_local_pet_farm_animal_coop_interior_missing");

        FarmAnimal animal = new(
            PetFarmAnimalFixtureAnimalType, Game1.random.Next(int.MaxValue), player.UniqueMultiplayerID);
        house.adoptAnimal(animal);
        if (house.animals.Count() != 1)
            throw new InvalidOperationException("fixture_native_local_pet_farm_animal_house_not_single_occupant");
        if (animal.wasPet.Value)
            throw new InvalidOperationException("fixture_native_local_pet_farm_animal_animal_already_petted");
        // A held Golden Animal Cracker is the seam's other no-op branch (FarmAnimal.cs:726): it would be
        // consumed instead of petting, and the action refuses it by name. The Given must not carry one.
        if (player.ActiveObject?.QualifiedItemId == "(O)GoldenAnimalCracker")
            throw new InvalidOperationException("fixture_native_local_pet_farm_animal_cracker_held");

        int animalTileX = (int)animal.Tile.X;
        int animalTileY = (int)animal.Tile.Y;
        Vector2? standingTile = new[]
            {
                animal.Tile + new Vector2(0f, 1f), animal.Tile + new Vector2(-1f, 0f),
                animal.Tile + new Vector2(1f, 0f), animal.Tile + new Vector2(0f, -1f),
            }
            .Where(tile => house.isTileOnMap(tile) && house.isTilePassable(tile)
                && !house.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
            .Cast<Vector2?>()
            .FirstOrDefault();
        if (standingTile is null)
            throw new InvalidOperationException("fixture_native_local_pet_farm_animal_approach_missing");

        player.warpFarmer(new Warp(0, 0, house.NameOrUniqueName, (int)standingTile.Value.X,
            (int)standingTile.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized pet-farm-animal precondition before bridge attachment: "
                + $"location={house.NameOrUniqueName};standing={(int)standingTile.Value.X},{(int)standingTile.Value.Y};"
                + $"animal={animal.myID.Value};type={animal.type.Value};tile={animalTileX},{animalTileY};"
                + $"friendship={animal.friendshipTowardFarmer.Value};was_pet={animal.wasPet.Value.ToString().ToLowerInvariant()};"
                + $"was_auto_pet={animal.wasAutoPet.Value.ToString().ToLowerInvariant()};"
                + $"house_animals={house.animals.Count()};time_of_day={Game1.timeOfDay}",
            LogLevel.Info);
    }
}
