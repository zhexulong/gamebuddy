namespace GameBuddy.Stardew.Core.Policy;

public enum FarmhandActionLifecycle
{
    Published,
    Experimental,
}

/// <summary>
/// The only executable ordinary-Farmhand action membership source. This catalog
/// is composed once at Mod startup; policy may expose or withdraw entries, but
/// no config, Host message, or bridge request can add an entry or choose its
/// native handler.
/// </summary>
public sealed record FarmhandActionRegistration(
    string ActionId,
    string FamilyId,
    int IdentityVersion,
    FarmhandActionLifecycle Lifecycle,
    FarmhandActionHandlerGroup HandlerGroup
);

public enum FarmhandActionHandlerGroup
{
    Movement,
    Farming,
    Gathering,
    MachinesAndAnimals,
    ResourceTools,
}

public static class FarmhandActionCatalog
{
    public static readonly IReadOnlyList<FarmhandActionRegistration> Registrations = Array.AsReadOnly(new[]
    {
        Registration("move_to_tile", "movement_navigation", 1, FarmhandActionHandlerGroup.Movement),
        Registration("equip_tool", "body_tools", 1, FarmhandActionHandlerGroup.ResourceTools),
        Registration("travel", "transport_warps", 1, FarmhandActionHandlerGroup.Movement),
        Registration("enter_exit", "movement_navigation", 1, FarmhandActionHandlerGroup.Movement),
        Registration("till_soil", "farming_crops", 1, FarmhandActionHandlerGroup.Farming),
        Registration("pickup_forage", "resource_gathering", 1, FarmhandActionHandlerGroup.Gathering),
        Registration("pickup_item", "inventory_items", 1, FarmhandActionHandlerGroup.Gathering),
        Registration("water_crop", "farming_crops", 1, FarmhandActionHandlerGroup.Farming),
        Registration("plant_seed", "farming_crops", 1, FarmhandActionHandlerGroup.Farming),
        Registration("fertilize_tile", "farming_crops", 1, FarmhandActionHandlerGroup.Farming),
        Registration("machine_inspect", "machines_processing", 1, FarmhandActionHandlerGroup.MachinesAndAnimals),
        Registration("machine_load", "machines_processing", 1, FarmhandActionHandlerGroup.MachinesAndAnimals),
        Registration("machine_collect_output", "machines_processing", 1, FarmhandActionHandlerGroup.MachinesAndAnimals),
        Registration("collect_animal_product", "animals_pets", 1, FarmhandActionHandlerGroup.MachinesAndAnimals),
        Registration("feed_animal", "animals_pets", 1, FarmhandActionHandlerGroup.MachinesAndAnimals),
        Registration("use_item", "inventory_items", 1, FarmhandActionHandlerGroup.MachinesAndAnimals),
        Registration("harvest_crop", "farming_crops", 1, FarmhandActionHandlerGroup.Farming),
        Registration("place_wood_fence", "buildings_farm_management", 1, FarmhandActionHandlerGroup.ResourceTools),
        Registration("place_crab_pot", "buildings_farm_management", 1, FarmhandActionHandlerGroup.ResourceTools),
        Registration("bait_crab_pot", "buildings_farm_management", 1, FarmhandActionHandlerGroup.ResourceTools),
        Registration("chop_tree_source", "resource_gathering", 1, FarmhandActionHandlerGroup.ResourceTools),
        Registration("break_rock_source", "resource_gathering", 1, FarmhandActionHandlerGroup.ResourceTools),
        Registration("clear_hoedirt", "farming_crops", 1, FarmhandActionHandlerGroup.Farming),
        Registration("dig_artifact_spot", "resource_gathering", 1, FarmhandActionHandlerGroup.ResourceTools),
        Registration("refill_watering_can", "farming_crops", 1, FarmhandActionHandlerGroup.ResourceTools),
        Registration("clear_debris", "resource_gathering", 1, FarmhandActionHandlerGroup.ResourceTools, FarmhandActionLifecycle.Experimental),
        Registration("npc_relationship", "npc_social", 1, FarmhandActionHandlerGroup.MachinesAndAnimals, FarmhandActionLifecycle.Experimental),
        Registration("pet_animal", "animals_pets", 1, FarmhandActionHandlerGroup.MachinesAndAnimals, FarmhandActionLifecycle.Experimental),
    });

    static FarmhandActionCatalog()
    {
        if (Registrations.Select(registration => registration.ActionId).Distinct(StringComparer.Ordinal).Count() != Registrations.Count)
            throw new InvalidOperationException("Farmhand action registrations must have unique action IDs.");
    }

    private static FarmhandActionRegistration Registration(
        string actionId,
        string familyId,
        int identityVersion,
        FarmhandActionHandlerGroup handlerGroup,
        FarmhandActionLifecycle lifecycle = FarmhandActionLifecycle.Published) =>
        new(actionId, familyId, identityVersion, lifecycle, handlerGroup);
}
