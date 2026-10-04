using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// WIA world-interruption live precondition for the ACTIVE ANIMAL PRODUCT slot
    /// (world-interruption-arbitration.md §4.1 ② / §4.3).
    ///
    /// Unlike the item-use slot, MilkPail/Shears finish their tool animation across
    /// later ticks and the ExecutionManager mints the terminal from that deferred
    /// completion path. So this fixture stages the native modal AFTER the animation
    /// has started; the arbiter must terminate the SAME execution exactly once as
    /// invalidated/modal_interrupted, and the deferred path must only release the
    /// slot (never mint a second terminal).
    ///
    /// SetupBigFarm is the same target-version pre-attachment setup the shipped
    /// collect_animal_product fixture uses: it supplies an adult animal with a ready
    /// product. This fixture only positions the local Player adjacent to that animal
    /// and opens a real modal; collection, produce clearing, inventory output and
    /// every receipt stay production-owned.
    /// </summary>
    private void InstallWiaAnimalProductInterruptionFixture(Farmer player, GameLocation farm)
    {
        if (player.MaxItems < 36)
            player.increaseBackpackSize(36 - player.MaxItems);

        GameLocation? productSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("SetupBigFarm", null))
                throw new InvalidOperationException("fixture_native_wia_animal_product_setup_unavailable");
        }
        finally { Game1.currentLocation = productSetupPreviousLocation; }

        (StardewValley.AnimalHouse House, FarmAnimal Animal, Tool AnimalTool, string ToolKind)? compatible = farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.AnimalHouse>()
            .SelectMany(house => house.animals.Values.Select(animal => (House: house, Animal: animal)))
            .Where(candidate => candidate.Animal.isAdult() && candidate.Animal.currentProduce.Value is not null)
            .Select(candidate => candidate.Animal.CanGetProduceWithTool(new MilkPail())
                ? (candidate.House, candidate.Animal, AnimalTool: (Tool)new MilkPail(), ToolKind: "milk_pail")
                : candidate.Animal.CanGetProduceWithTool(new Shears())
                    ? (candidate.House, candidate.Animal, AnimalTool: (Tool)new Shears(), ToolKind: "shears")
                    : ((StardewValley.AnimalHouse House, FarmAnimal Animal, Tool AnimalTool, string ToolKind)?)null)
            .FirstOrDefault(candidate => candidate is not null);
        if (compatible is null)
            throw new InvalidOperationException("fixture_native_wia_animal_product_ready_animal_missing");

        Vector2? standingTile = new[]
        {
            compatible.Value.Animal.Tile + new Vector2(0f, 1f), compatible.Value.Animal.Tile + new Vector2(-1f, 0f),
            compatible.Value.Animal.Tile + new Vector2(1f, 0f), compatible.Value.Animal.Tile + new Vector2(0f, -1f),
        }.Where(tile => compatible.Value.House.isTileOnMap(tile) && compatible.Value.House.isTilePassable(tile)
            && !compatible.Value.House.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.None, useFarmerTile: false))
            .Cast<Vector2?>().FirstOrDefault();
        if (standingTile is null)
            throw new InvalidOperationException("fixture_native_wia_animal_product_approach_missing");
        if (!player.Items.OfType<Tool>().Any(tool => tool.GetType() == compatible.Value.AnimalTool.GetType())
            && player.addItemToInventory(compatible.Value.AnimalTool) is not null)
            throw new InvalidOperationException("fixture_native_wia_animal_product_tool_inventory_full");
        if (!player.Items.OfType<Tool>().Any(tool => tool.GetType() == compatible.Value.AnimalTool.GetType()))
            throw new InvalidOperationException("fixture_native_wia_animal_product_tool_missing_after_add");

        string animalHouseName = compatible.Value.House.NameOrUniqueName;
        long animalId = compatible.Value.Animal.myID.Value;
        string produceId = compatible.Value.Animal.currentProduce.Value!;
        string toolKind = compatible.Value.ToolKind;
        player.warpFarmer(new StardewValley.Warp(0, 0, animalHouseName, (int)standingTile.Value.X, (int)standingTile.Value.Y, false));

        int ticksAfterAnimationStart = 0;
        bool positioned = false;
        void OnTick(object? sender, UpdateTickedEventArgs e)
        {
            Farmer? actor = Game1.player;
            if (actor is null || actor.currentLocation is not StardewValley.AnimalHouse house
                || !string.Equals(house.NameOrUniqueName, animalHouseName, StringComparison.Ordinal))
                return;
            if (!house.animals.TryGetValue(animalId, out FarmAnimal? animal)
                || !animal.isAdult()
                || animal.currentProduce.Value != produceId
                || !actor.Items.OfType<Tool>().Any(tool => toolKind == "milk_pail" ? tool is MilkPail : tool is Shears))
            {
                this.Helper.Events.GameLoop.UpdateTicked -= OnTick;
                this.Monitor.Log("GameBuddy native-local-player WIA animal-product fixture lost its ready-animal precondition before the modal could interrupt the animation.", LogLevel.Error);
                return;
            }
            if (!positioned)
            {
                bool productInRange = Math.Abs((int)actor.Tile.X - (int)animal.Tile.X) <= 1
                    && Math.Abs((int)actor.Tile.Y - (int)animal.Tile.Y) <= 1;
                if (!productInRange && TryFindNativeLocalAnimalProductApproach(house, animal, out Vector2 approach))
                    actor.Position = approach * Game1.tileSize;
                positioned = true;
                return;
            }
            // UsingTool is the public native signal that the collect_animal_product
            // handler's BeginUsingTool lifecycle is running on the bound animal;
            // ExecutionManager's private activeAnimalProduct slot is never read here.
            if (!actor.UsingTool)
            {
                ticksAfterAnimationStart = 0;
                return;
            }
            ticksAfterAnimationStart++;
            if (ticksAfterAnimationStart < 2)
                return;
            Game1.drawObjectDialogue("GameBuddy WIA animal-product modal interruption probe");
            this.Helper.Events.GameLoop.UpdateTicked -= OnTick;
        }
        this.Helper.Events.GameLoop.UpdateTicked += OnTick;
        this.Monitor.Log($"GameBuddy native-local-player initialized WIA animal-product interrupt precondition before bridge attachment: animal_house={animalHouseName}; animal={animalId}; produce=(O){produceId}; tool={toolKind}. Production alone collects, receives modal_interrupted once, dismisses and retries.", LogLevel.Info);
    }
}
