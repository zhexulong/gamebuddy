using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeAnimalProductFixture(StardewValley.Farm farm, StardewValley.AnimalHouse[] houses)
    {
    (FarmAnimal Animal, Tool Tool, string ToolKind)? compatible = houses
        .SelectMany(house => house.animals.Values)
        .Where(animal => animal.isAdult() && !string.IsNullOrWhiteSpace(animal.currentProduce.Value))
        .Select(animal => animal.CanGetProduceWithTool(new MilkPail())
            ? (Animal: animal, Tool: (Tool)new MilkPail(), ToolKind: "MilkPail")
            : animal.CanGetProduceWithTool(new Shears())
                ? (Animal: animal, Tool: (Tool)new Shears(), ToolKind: "Shears")
                : ((FarmAnimal Animal, Tool Tool, string ToolKind)?)null)
        .FirstOrDefault(candidate => candidate is not null);
    if (compatible is null)
        throw new InvalidOperationException("fixture_native_compatible_ready_animal_missing");

    // The debug helper equips only the Host. For this disposable fixture,
    // establish the *already bound* Farmhand's starting inventory using
    // the same target-version Farmer inventory API. Never infer an ID:
    // it must match a retained Cabin owner before LAN/attachment begins.
    if (!long.TryParse(this.config.PlayerId, out long configuredFarmhandId))
        throw new InvalidOperationException("fixture_farmhand_id_invalid");
    Farmer? farmhand = Game1.GetPlayer(configuredFarmhandId, onlyOnline: false);
    bool ownsRetainedCabin = farmhand is not null && farm.buildings
        .Select(building => building.GetIndoors())
        .OfType<StardewValley.Locations.Cabin>()
        .Any(cabin => cabin.OwnerId == configuredFarmhandId);
    if (!ownsRetainedCabin || farmhand is null)
        throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
    if (farmhand.MaxItems < 36)
        farmhand.increaseBackpackSize(36 - farmhand.MaxItems);
    bool hasCompatibleTool = compatible.Value.Tool is MilkPail
        ? farmhand.Items.OfType<MilkPail>().Any()
        : farmhand.Items.OfType<Shears>().Any();
    // addItemToInventoryBool intentionally refuses non-local Farmers.
    // Use the target-version inventory mutation API which applies its
    // normal MaxItems/empty-slot/stack rules to this offline Farmhand.
    if (!hasCompatibleTool && farmhand.addItemToInventory(compatible.Value.Tool) is not null)
        throw new InvalidOperationException("fixture_farmhand_tool_inventory_full");
    bool hasCompatibleToolAfter = compatible.Value.Tool is MilkPail
        ? farmhand.Items.OfType<MilkPail>().Any()
        : farmhand.Items.OfType<Shears>().Any();
    if (!hasCompatibleToolAfter)
        throw new InvalidOperationException("fixture_farmhand_compatible_tool_missing_after_add");

    this.hostAutomationFixtureInitialized = true;
    string houseFacts = string.Join("|", houses.Select(house =>
    {
        string animals = string.Join(",", house.animals.Values.Select(animal => $"{animal.type.Value}@{(int)animal.Tile.X},{(int)animal.Tile.Y}:adult={animal.isAdult()}:produce={animal.currentProduce.Value ?? "none"}:milkable={animal.CanGetProduceWithTool(new MilkPail())}:shearable={animal.CanGetProduceWithTool(new Shears())}"));
        return $"{house.NameOrUniqueName}[{animals}]";
    }));
    this.Monitor.Log($"GameBuddy HostAutomation initialized native animal-product v2 fixture before attachment: animal_houses={houses.Length}; Cabin retained; selected={compatible.Value.Animal.type.Value}@{(int)compatible.Value.Animal.Tile.X},{(int)compatible.Value.Animal.Tile.Y}; tool={compatible.Value.ToolKind}; Farmhand inventory_slots={farmhand.MaxItems}; compatible_tool={hasCompatibleToolAfter}; houses={houseFacts}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
    }
}
