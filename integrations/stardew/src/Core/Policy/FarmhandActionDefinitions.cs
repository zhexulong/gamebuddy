namespace GameBuddy.Stardew.Core.Policy;

public enum FarmhandActionLifecycle
{
    Published,
    Experimental,
}

public sealed record FarmhandActionDefinition(
    string ActionId,
    string FamilyId,
    int IdentityVersion,
    FarmhandActionLifecycle Lifecycle
);

public static class FarmhandActionCatalog
{
    public static readonly IReadOnlyList<FarmhandActionDefinition> Definitions = Array.AsReadOnly(new[]
    {
        Definition("move_to_tile", "movement_navigation", 1),
        Definition("equip_tool", "body_tools", 1),
        Definition("travel", "transport_warps", 1),
        Definition("enter_exit", "movement_navigation", 1),
        Definition("till_soil", "farming_crops", 1),
        Definition("pickup_forage", "resource_gathering", 1),
        Definition("pickup_item", "inventory_items", 1),
        Definition("water_crop", "farming_crops", 1),
        Definition("plant_seed", "farming_crops", 1),
        Definition("fertilize_tile", "farming_crops", 1),
        Definition("machine_inspect", "machines_processing", 1),
        Definition("machine_load", "machines_processing", 1),
        Definition("machine_collect_output", "machines_processing", 1),
        Definition("collect_animal_product", "animals_pets", 1),
        Definition("feed_animal", "animals_pets", 1),
        Definition("use_item", "inventory_items", 1),
        Definition("harvest_crop", "farming_crops", 1),
        Definition("place_wood_fence", "buildings_farm_management", 1),
        Definition("place_crab_pot", "buildings_farm_management", 1),
        Definition("bait_crab_pot", "buildings_farm_management", 1),
        Definition("chop_tree_source", "resource_gathering", 1),
        Definition("break_rock_source", "resource_gathering", 1),
        Definition("clear_hoedirt", "farming_crops", 1),
        Definition("dig_artifact_spot", "resource_gathering", 1),
        Definition("refill_watering_can", "farming_crops", 1),
        Definition("clear_debris", "resource_gathering", 1, FarmhandActionLifecycle.Experimental),
        Definition("npc_relationship", "npc_social", 1, FarmhandActionLifecycle.Experimental),
        Definition("pet_animal", "animals_pets", 1, FarmhandActionLifecycle.Experimental),
    });

    private static FarmhandActionDefinition Definition(
        string actionId,
        string familyId,
        int identityVersion,
        FarmhandActionLifecycle lifecycle = FarmhandActionLifecycle.Published) =>
        new(actionId, familyId, identityVersion, lifecycle);
}
