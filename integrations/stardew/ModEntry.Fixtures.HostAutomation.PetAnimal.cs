using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativePetFixture(StardewValley.Farm farm)
    {
        // Pre-attachment fixture only, on the Host side of the LAN topology:
        // exactly one unpetted native Pet on the Farm next to the arrival the
        // attached Farmhand lands on. Production alone calls Pet.checkAction,
        // records the daily interaction, applies friendship, and emits a
        // matching terminal receipt.
        Farmer farmhand = this.ResolveHostAutomationFarmhand(farm);
        Vector2 farmArrival = ResolveHostAutomationFarmArrival(farmhand, farm, "pet");
        // Do not require the arrival tile itself to be free. The game warps the
        // actor onto it, and pet_animal admits its target through
        // Utility.tileWithinRadiusOfPlayer(..., 1, player) -- a distance check
        // with no pathfinding -- so what the fixture must guarantee is a legal
        // Pet tile inside that radius, not a pristine landing tile. The existing
        // NPC fixture likewise never asserts the arrival is walkable. Record the
        // arrival state instead, so a later failure is diagnosable.
        bool arrivalPassable = farm.isTilePassable(farmArrival);
        bool arrivalOccupied = farm.IsTileOccupiedBy(farmArrival, CollisionMask.All, CollisionMask.None, useFarmerTile: true);
        // pet_animal admits the target through
        // Utility.tileWithinRadiusOfPlayer(..., 1, player) and resolves the
        // location from the actor's own currentLocation, so the Pet must sit
        // inside the Chebyshev-1 window of the arrival tile and on the Farm.
        //
        // Placement distance is deliberate: radius 1 would sit the Pet on the
        // actor's landing corridor. A Pet is a colliding character that re-rolls
        // its facing every tick (Pet.RunState -> Game1.random.Next(0,4)) and also
        // pushes the actor (petPushEvent), so a Pet two tiles from the arrival
        // walks back and forth across every exit the actor would use, and every
        // approach move dies native_path_ended with the actor never leaving
        // (measured live: 24 moves, 4 no_native_path + 20 native_path_ended).
        //
        // Radius 2 is the sweet spot. It keeps the Pet off the actor's landing
        // corridor, yet close enough that the actor reaches it in 1-2 moves --
        // before a Dog's Sprint (MoveSpeed 6, 1-3.5s) or its random facing
        // re-roll can carry it out of DiscoverPetTargets' radius-6 window.
        // At radius 3-4 the actor's ~40s approach (warp, then walk) gave the Pet
        // the whole journey to wander away, so the actor arrived to an empty
        // discovery list (measured live: pet placed 22,33; actor walked to
        // 22,33; petTargets empty).
        Vector2[] candidates =
        {
            farmArrival + new Vector2(2f, 0f),
            farmArrival + new Vector2(-2f, 0f),
            farmArrival + new Vector2(0f, 2f),
            farmArrival + new Vector2(0f, -2f),
            farmArrival + new Vector2(2f, 2f),
            farmArrival + new Vector2(-2f, 2f),
            farmArrival + new Vector2(2f, -2f),
            farmArrival + new Vector2(-2f, -2f),
        };
        Vector2? targetTile = candidates
            .Where(tile => farm.isTileOnMap(tile)
                && farm.isTilePassable(tile)
                && !farm.objects.ContainsKey(tile)
                && !farm.terrainFeatures.ContainsKey(tile)
                && !farm.characters.Any(character => character.Tile == tile)
                && Math.Max(Math.Abs(tile.X - farmArrival.X), Math.Abs(tile.Y - farmArrival.Y)) <= 2)
            .Cast<Vector2?>()
            .FirstOrDefault();
        if (targetTile is null)
            throw new InvalidOperationException($"fixture_native_pet_placement_missing:arrival={(int)farmArrival.X},{(int)farmArrival.Y}");
        // Pet.checkAction requires empty hands; the bound Farmhand is the actor
        // that will become Game1.player on the AI client, so clear that actor's
        // selected slot. This is a legal pre-attachment starting condition, not
        // an invocation of the interaction or any of its result mutations.
        if (farmhand.CurrentToolIndex >= 0 && farmhand.CurrentToolIndex < farmhand.Items.Count)
            farmhand.Items[farmhand.CurrentToolIndex] = null;
        StardewValley.Characters.Pet pet = new((int)targetTile.Value.X, (int)targetTile.Value.Y, "0", "Dog");
        pet.Name = "Dog";
        pet.homeLocationName.Value = farm.NameOrUniqueName;
        pet.grantedFriendshipForPet.Value = false;
        pet.friendshipTowardFarmer.Value = 0;
        farm.addCharacter(pet);
        pet.currentLocation = farm;
        // addCharacter owns the location registration. Validate only the
        // action-relevant native starting facts here; production rediscovery
        // binds the exact later coordinate and opaque target ID.
        if (!farm.characters.Contains(pet)
            || pet.currentLocation != farm
            || pet.petId.Value == Guid.Empty
            || pet.grantedFriendshipForPet.Value
            || pet.friendshipTowardFarmer.Value != 0
            || pet.lastPetDay.TryGetValue(farmhand.UniqueMultiplayerID, out int lastDay) && lastDay == Game1.Date.TotalDays)
            throw new InvalidOperationException("fixture_native_pet_placement_validation_failed");
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native pet-animal v1 fixture before attachment: Cabin retained; farmhand={farmhand.UniqueMultiplayerID}; pet_type={pet.petType.Value}; pet_id={pet.petId.Value:N}; tile={(int)targetTile.Value.X},{(int)targetTile.Value.Y}; farm_arrival={(int)farmArrival.X},{(int)farmArrival.Y}; arrival_passable={arrivalPassable}; arrival_occupied={arrivalOccupied}; friendship=0; petted_today=false; friendship_callback=false; hands_empty=true; production alone invokes Pet.checkAction and emits receipt.", LogLevel.Info);
    }
}
